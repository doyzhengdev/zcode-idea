/**
 * 插件分发源：解析 base URL、拉取远端 manifest + 签名、验证 Ed25519 签名、
 * 校验 manifest 字段与 archivePath，并提供版本比较。
 *
 * 安全模型：
 * - 信任根是 npm 包内置的公钥 `lib/plugin-signing-public.pem`（与仓库
 *   `src/main/resources/runtime-signing-public.pem` 同一把）；
 * - 签名对象是 manifest.json 的**原始字节**，签名文件是 base64 文本；
 * - manifest 通过后才采信其中的 sha256/size/version，用于校验 zip。
 *
 * 默认源是当前唯一可用的七牛测试域名（HTTP），因此无需 --allow-http；
 * 用户显式指定其他 HTTP 源时必须加 --allow-http，HTTPS 直接允许。
 */

import { createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { InstallError, UsageError } from "./errors.mjs";
import { warn } from "./log.mjs";

/** 七牛测试域名（HTTP）。生产环境请用 --source / ZCODE_IDE_PLUGIN_BASE_URL 指定 HTTPS 域名。 */
export const DEFAULT_PLUGIN_BASE_URL =
  "http://tnbe4cmeo.hn-bkt.clouddn.com/zcode-ide/plugin/stable";

export const BUNDLED_PUBLIC_KEY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "plugin-signing-public.pem",
);

const HTTP_HEADERS = {
  "User-Agent": "zcode-idea-installer",
  "Cache-Control": "no-cache",
};
const RETRY_BACKOFF_MS = 500;

/* -------------------------------------------------------------------------- */
/* 源解析                                                                      */
/* -------------------------------------------------------------------------- */

function stripTrailingSlashes(value) {
  return String(value).replace(/\/+$/, "");
}

/**
 * 解析插件源。
 * 优先级：--source > ZCODE_IDE_PLUGIN_BASE_URL > DEFAULT_PLUGIN_BASE_URL。
 *
 * @returns {{baseUrl: string, isDefault: boolean, isHttp: boolean}}
 */
export function resolvePluginSource({ source, env = process.env, allowHttp = false } = {}) {
  const fromEnv = env.ZCODE_IDE_PLUGIN_BASE_URL?.trim();
  const explicit = typeof source === "string" && source.trim() ? source.trim() : null;
  const raw = explicit ?? (fromEnv ? fromEnv : DEFAULT_PLUGIN_BASE_URL);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`插件源不是合法 URL：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`插件源只支持 http/https：${raw}`);
  }
  if (url.search || url.hash) {
    throw new UsageError(`插件源不能带查询参数或锚点：${raw}`);
  }

  const baseUrl = stripTrailingSlashes(raw);
  const isDefault = baseUrl === DEFAULT_PLUGIN_BASE_URL;
  const isHttp = url.protocol === "http:";

  if (isHttp && !isDefault && !allowHttp) {
    throw new UsageError(
      `插件源是 HTTP（${baseUrl}）：生产环境必须使用 HTTPS；` +
        "测试域名联调请显式加 --allow-http。",
    );
  }

  return { baseUrl, isDefault, isHttp };
}

/* -------------------------------------------------------------------------- */
/* 版本化清单地址                                                              */
/* -------------------------------------------------------------------------- */

const MANIFEST_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * 校验用于定位清单的版本号（npm 包版本）。
 * 只允许 semver，禁止 `/`、`..`、反斜杠等路径字符。
 */
export function validateManifestVersion(version) {
  if (typeof version !== "string" || !version.trim()) {
    throw new UsageError(
      "缺少版本号：安装器需要 npm 包版本（例如 0.0.3）来定位版本化清单。",
    );
  }
  const normalized = version.trim();
  if (!MANIFEST_VERSION_RE.test(normalized)) {
    throw new UsageError(
      `版本号不合法：${version}（只允许 semver，禁止 /、..、反斜杠等路径字符）。`,
    );
  }
  return normalized;
}

/** 版本化 manifest 地址：<baseUrl>/<version>/manifest.json。 */
export function manifestUrlFor(baseUrl, version) {
  const normalized = validateManifestVersion(version);
  return `${stripTrailingSlashes(baseUrl)}/${normalized}/manifest.json`;
}

/* -------------------------------------------------------------------------- */
/* 验签                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 校验 manifest.sig（base64 Ed25519 签名）是否匹配 manifest 原始字节。
 * 失败抛 InstallError，调用方必须中止安装。
 */
export function verifyManifestSignature(manifestBytes, sigBytes, options = {}) {
  let publicKeyPem = options.publicKeyPem;
  if (!publicKeyPem) {
    const keyPath = options.publicKeyPath ?? BUNDLED_PUBLIC_KEY_PATH;
    try {
      publicKeyPem = fs.readFileSync(keyPath, "utf8");
    } catch (err) {
      throw new InstallError(`无法读取内置插件公钥 ${keyPath}：${err.message}`);
    }
  }

  const signatureText = Buffer.from(sigBytes).toString("utf8").trim();
  const signature = Buffer.from(signatureText, "base64");
  if (signature.length !== 64) {
    throw new InstallError(
      `manifest.sig 解码后长度 ${signature.length}，不是 Ed25519 的 64 字节签名。已中止安装。`,
    );
  }

  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch (err) {
    throw new InstallError(`内置插件公钥无法解析：${err.message}`);
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new InstallError("内置插件公钥不是 Ed25519 公钥，拒绝继续。");
  }
  if (!verify(null, manifestBytes, publicKey, signature)) {
    throw new InstallError(
      "manifest.sig 验签失败：清单可能被篡改或签名不匹配。已中止安装。",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* manifest 校验                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 校验 archivePath：必须是相对 CDN 根的安全对象键。
 * 拒绝绝对 URL、以 / 开头、`..`、反斜杠、查询参数/锚点、空路径段。
 */
export function validateArchivePath(archivePath) {
  if (typeof archivePath !== "string" || !archivePath) {
    throw new InstallError("远端 manifest 的 archivePath 为空");
  }
  if (archivePath.includes("\0")) {
    throw new InstallError("远端 manifest 的 archivePath 包含空字符");
  }
  if (archivePath.includes("\\")) {
    throw new InstallError(`远端 manifest 的 archivePath 不能包含反斜杠：${archivePath}`);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(archivePath)) {
    throw new InstallError(`远端 manifest 的 archivePath 不能是绝对 URL：${archivePath}`);
  }
  if (archivePath.startsWith("/")) {
    throw new InstallError(`远端 manifest 的 archivePath 不能以 / 开头：${archivePath}`);
  }
  if (/[?#]/.test(archivePath)) {
    throw new InstallError(
      `远端 manifest 的 archivePath 不能包含查询参数或锚点：${archivePath}`,
    );
  }
  if (/%2e|%2f|%5c/i.test(archivePath)) {
    throw new InstallError(
      `远端 manifest 的 archivePath 不能包含百分号编码的路径分隔符或点号：${archivePath}`,
    );
  }
  const segments = archivePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new InstallError(`远端 manifest 的 archivePath 含有非法路径段：${archivePath}`);
  }
  if (path.posix.normalize(archivePath) !== archivePath) {
    throw new InstallError(`远端 manifest 的 archivePath 不是规范化的相对路径：${archivePath}`);
  }
  return archivePath;
}

/** 校验远端 manifest 的字段；返回规范化后的对象。 */
export function validatePluginManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InstallError("远端 manifest 不是 JSON 对象");
  }
  if (value.schemaVersion !== 1) {
    throw new InstallError(
      `远端 manifest 的 schemaVersion 不受支持：${value.schemaVersion}（期望 1）`,
    );
  }
  for (const field of ["channel", "pluginVersion", "archivePath", "sha256"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new InstallError(`远端 manifest 缺少字段 ${field}`);
    }
  }
  validateArchivePath(value.archivePath);
  if (!/^[0-9a-f]{64}$/i.test(value.sha256)) {
    throw new InstallError("远端 manifest 的 sha256 格式不正确（期望 64 位十六进制）");
  }
  if (!Number.isInteger(value.size) || value.size <= 0) {
    throw new InstallError(`远端 manifest 的 size 不合法：${value.size}`);
  }
  if (value.builtAt !== undefined && typeof value.builtAt !== "string") {
    throw new InstallError("远端 manifest 的 builtAt 必须是字符串");
  }
  return {
    schemaVersion: 1,
    channel: value.channel,
    pluginVersion: value.pluginVersion.trim(),
    archivePath: value.archivePath,
    sha256: value.sha256.toLowerCase(),
    size: value.size,
    builtAt: value.builtAt ?? "",
  };
}

/**
 * 计算插件包的下载地址。
 *
 * archivePath 是相对 CDN 根的对象键（与 runtime manifest 一致，例如
 * `zcode-ide/plugin/stable/zcode-ide-0.1.0.zip`）。若它正好以 source 的路径前缀开头，
 * 就从域名根解析；否则按“相对 manifest 目录”解析，兼容只写文件名的旧清单。
 */
export function archiveUrlFor(baseUrl, archivePath) {
  validateArchivePath(archivePath);
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const basePath = base.pathname.replace(/^\/+|\/+$/g, "");
  if (basePath && (archivePath === basePath || archivePath.startsWith(`${basePath}/`))) {
    return new URL(`/${archivePath}`, base.origin).toString();
  }
  return new URL(archivePath, base).toString();
}

/* -------------------------------------------------------------------------- */
/* 版本比较                                                                    */
/* -------------------------------------------------------------------------- */

function tokenizeVersion(value) {
  return String(value ?? "")
    .trim()
    .replace(/^v/i, "")
    .match(/\d+|[a-zA-Z]+/g) ?? [];
}

/**
 * 比较两个插件版本：a > b 返回 1，a === b 返回 0，a < b 返回 -1。
 * 数字段按数值比较；预发布后缀（如 -beta）视为小于正式版。
 */
export function comparePluginVersions(a, b) {
  const left = tokenizeVersion(a);
  const right = tokenizeVersion(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return /^\d+$/.test(y) ? -1 : 1;
    if (y === undefined) return /^\d+$/.test(x) ? 1 : -1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    if (xNumeric !== yNumeric) return xNumeric ? 1 : -1;
    const diff = x.localeCompare(y, "en");
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* 网络                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 带重试的小文件下载（manifest / sig）。网络错误与 408/429/5xx 会重试；
 * 其他 4xx 立即失败（例如 404 说明源地址或发布状态不对）。
 */
export async function fetchBufferWithRetry(
  url,
  { retries = 3, timeoutMs = 60_000, label = "资源" } = {},
) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: HTTP_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return Buffer.from(await response.arrayBuffer());

      const retriable =
        response.status === 408 || response.status === 429 || response.status >= 500;
      const message = `获取 ${label} 失败：HTTP ${response.status} ${response.statusText}（${url}）`;
      if (!retriable) {
        throw new InstallError(
          `${message}。请确认插件源地址与发布状态（--source / ZCODE_IDE_PLUGIN_BASE_URL）。`,
        );
      }
      lastError = new Error(message);
    } catch (err) {
      if (err instanceof InstallError) throw err;
      lastError = err;
    }
    if (attempt < retries) {
      const delay = RETRY_BACKOFF_MS * attempt;
      warn(
        `获取 ${label} 失败（第 ${attempt}/${retries} 次）：${lastError?.message ?? "未知错误"}；` +
          `${delay}ms 后重试…`,
      );
      await sleep(delay);
    }
  }
  throw new InstallError(
    `获取 ${label} 失败（已重试 ${retries} 次）：${lastError?.message ?? "未知错误"}。` +
      "请检查网络，或用 --zip <本地 zip> 离线安装。",
  );
}

/**
 * 拉取并校验远端**版本化** manifest（json + sig）。
 * 地址：<baseUrl>/<version>/manifest.json|.sig。
 * 验签失败会抛错，调用方不得继续。
 */
export async function fetchManifestBundle({
  baseUrl,
  version,
  retries = 3,
  timeoutMs = 60_000,
  publicKeyPem,
  publicKeyPath,
} = {}) {
  if (!baseUrl) throw new InstallError("缺少插件源地址");
  const base = stripTrailingSlashes(baseUrl);
  const manifestUrl = manifestUrlFor(base, version);
  const sigUrl = manifestUrl.replace(/manifest\.json$/, "manifest.sig");

  const manifestBytes = await fetchBufferWithRetry(manifestUrl, {
    retries,
    timeoutMs,
    label: "远端 manifest",
  });
  const sigBytes = await fetchBufferWithRetry(sigUrl, {
    retries,
    timeoutMs,
    label: "manifest 签名",
  });

  verifyManifestSignature(manifestBytes, sigBytes, { publicKeyPem, publicKeyPath });

  let parsed;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch (err) {
    throw new InstallError(`远端 manifest 不是合法 JSON：${err.message}`);
  }
  const manifest = validatePluginManifest(parsed);

  return {
    manifest,
    manifestBytes,
    sigBytes,
    manifestUrl,
    sigUrl,
    archiveUrl: archiveUrlFor(base, manifest.archivePath),
  };
}
