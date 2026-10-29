#!/usr/bin/env node
/**
 * 一条命令完成插件发布：版本检查 → 构建 → manifest 签名 → 七牛上传 → npm 发布。
 *
 * 版本单一来源：scripts/npm/package.json 的 version（npm 包与插件同一版本）。
 * 仓库根 package.json 的 version 必须与之一致，发布前硬校验；
 * 插件版本同时用于 OSS 对象路径、版本化清单目录、manifest.pluginVersion 与 npm 包。
 *
 * 默认 dry-run：只读版本、检查环境、打印将执行的命令/对象 key/URL，不构建、不写文件、不上传、不发 npm。
 *
 * 两级执行：
 *   --apply          执行本地步骤（构建/复用 zip、生成 manifest + sig），并做远端计划的预检；
 *                    不产生任何远端副作用。
 *   --apply --push   真正上传七牛、发布 npm（这是唯一的远端写入开关）。
 *
 * 用法：
 *   node scripts/release.mjs [--apply] [--push] [--skip-build] [--bundle-runtime]
 *                            [--npm] [--no-oss] [--channel stable] [--prefix zcode-ide]
 *                            [--registry <url>] [--allow-http] [--allow-downgrade]
 *                            [--skip-runtime] [--out <dir>]
 */

import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const npmDir = path.join(repoRoot, "scripts", "npm");
const npmPackageJsonPath = path.join(npmDir, "package.json");
const gradlePropsPath = path.join(repoRoot, "gradle.properties");
const distDir = path.join(repoRoot, "build", "distributions");
const repoPublicKeyPath = path.join(
  repoRoot,
  "src",
  "main",
  "resources",
  "runtime-signing-public.pem",
);
const npmPublicKeyPath = path.join(npmDir, "lib", "plugin-signing-public.pem");
const DEFAULT_OUT_DIR = path.join(repoRoot, "build", "plugin-release");
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const TAG = "[release]";

function info(message) {
  console.log(`${TAG} ${message}`);
}

function warn(message) {
  console.warn(`${TAG} 警告：${message}`);
}

function fail(message) {
  console.error(`${TAG} 错误：${message}`);
  process.exit(1);
}

function step(number, title) {
  console.log(`${TAG} ${number}/5 ${title}`);
}

function printUsage() {
  console.log(`用法：
  node scripts/release.mjs [选项]

默认 dry-run：只读版本/环境并打印计划，不构建、不写文件、不上传、不发 npm。

选项：
  --apply              执行本地步骤（构建或复用 zip、生成 manifest + sig），不做远端写入
  --push               与 --apply 一起使用，才真正上传七牛/发布 npm
  --build-only         只构建插件 zip（build-runtime + gradlew），不生成 manifest、不上传、不发 npm
  --skip-build         复用 build/distributions 里最新的 zip（仍校验版本一致性）
  --bundle-runtime     构建时追加 -PbundleRuntime=true（完整包）
  --skip-runtime       构建时跳过 scripts/build-runtime.mjs
  --npm                发布 npm 小包（配合 --apply --push）
  --no-oss             不上传七牛（可与 --npm 组合）
  --channel <c>        manifest.channel / 对象路径，默认 stable
  --prefix <p>         对象键前缀，默认取 QINIU_PREFIX 或 zcode-ide
  --registry <url>     npm registry，默认 ${DEFAULT_REGISTRY}
  --allow-http         允许 HTTP 测试域名（生产必须 HTTPS）
  --allow-downgrade    兼容旧参数：zip 版本与插件版本不一致时只警告（仅联调）
  --out <dir>          发布产物目录，默认 build/plugin-release
  -h, --help           显示本帮助

对象布局（archivePath 含 prefix，安装器从域名根解析）：
  <prefix>/plugin/<channel>/<version>/manifest.json|.sig               版本化清单（安装器读取）
  <prefix>/plugin/<channel>/<version>/zcode-ide-<version>-<sha12>.zip  内容寻址，不覆盖
  <prefix>/plugin/<channel>/manifest.json|.sig                         稳定指针（兼容旧版安装器）

版本规则：
  - 仓库根 package.json 与 scripts/npm/package.json 的 version 必须完全一致；
  - 唯一版本源是 scripts/npm/package.json 的 version（插件/OSS/清单/npm 同源）；
  - 构建使用 ./gradlew buildPlugin -PpluginVersion=<version>，jar 内版本必须与之一致；
  - 同版本可以重发：zip 用内容寻址 key，旧 zip 保留；版本化清单目录按版本固定；
  - npm 同版本不可覆盖，--npm 发布前会检查远端是否已存在该版本。`);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    push: false,
    buildOnly: false,
    skipBuild: false,
    bundleRuntime: false,
    npm: false,
    noOss: false,
    channel: "stable",
    prefix: process.env.QINIU_PREFIX?.trim() || "zcode-ide",
    registry: DEFAULT_REGISTRY,
    allowHttp: false,
    allowDowngrade: false,
    skipRuntime: false,
    out: DEFAULT_OUT_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[(index += 1)];
      if (!next || next.startsWith("--")) fail(`${arg} 需要一个参数值`);
      return next;
    };
    switch (arg) {
      case "--apply":
        args.apply = true;
        break;
      case "--push":
        args.push = true;
        break;
      case "--build-only":
        args.buildOnly = true;
        break;
      case "--skip-build":
        args.skipBuild = true;
        break;
      case "--bundle-runtime":
        args.bundleRuntime = true;
        break;
      case "--npm":
        args.npm = true;
        break;
      case "--no-oss":
        args.noOss = true;
        break;
      case "--channel":
        args.channel = value();
        break;
      case "--prefix":
        args.prefix = value();
        break;
      case "--registry":
        args.registry = value();
        break;
      case "--allow-http":
        args.allowHttp = true;
        break;
      case "--allow-downgrade":
        args.allowDowngrade = true;
        break;
      case "--skip-runtime":
        args.skipRuntime = true;
        break;
      case "--out":
        args.out = path.resolve(value());
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        fail(`未知参数：${arg}（--help 查看用法）`);
    }
  }

  if (!args.apply && args.push) fail("--push 必须与 --apply 一起使用");
  if (args.buildOnly && args.skipBuild) fail("--build-only 不能与 --skip-build 同时使用");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.channel)) {
    fail(`--channel 不合法：${args.channel}（只允许小写字母、数字、连字符）`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(args.prefix)) {
    fail(`--prefix 不合法：${args.prefix}（只允许单段路径：字母、数字、点、下划线、连字符）`);
  }
  let registryUrl;
  try {
    registryUrl = new URL(args.registry);
  } catch {
    fail(`--registry 不是合法 URL：${args.registry}`);
  }
  if (registryUrl.protocol !== "https:" && registryUrl.protocol !== "http:") {
    fail("--registry 只支持 http/https");
  }
  return args;
}

/* -------------------------------------------------------------------------- */
/* 版本                                                                        */
/* -------------------------------------------------------------------------- */

function tokenizeVersion(value) {
  return String(value ?? "").match(/\d+|[a-zA-Z]+/g) ?? [];
}

/** a > b → 1，相等 → 0，a < b → -1。 */
function compareVersions(a, b) {
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

function readGradlePluginVersion() {
  let text;
  try {
    text = fs.readFileSync(gradlePropsPath, "utf8");
  } catch (err) {
    fail(`无法读取 ${gradlePropsPath}：${err.message}`);
  }
  const match = /^\s*pluginVersion\s*=\s*(.+)$/m.exec(text);
  if (!match) fail(`无法从 ${gradlePropsPath} 读取 pluginVersion`);
  return match[1].trim();
}

/* -------------------------------------------------------------------------- */
/* 环境检查                                                                    */
/* -------------------------------------------------------------------------- */

function detectJavaVersion() {
  const javaCommand = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
  const result = spawnSync(javaCommand, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = /version "(\d+)/.exec(text);
  const firstLine = `${result.stdout ?? ""}${result.stderr ?? ""}`.split(/\r?\n/)[0]?.trim();
  return {
    major: match ? Number(match[1]) : null,
    detail: result.error ? result.error.message : firstLine || "未检测到 java",
  };
}

function checkJdk({ strict }) {
  const detected = detectJavaVersion();
  if (detected.major === 21) {
    info(`JDK：${detected.detail}（满足 21）`);
    return true;
  }
  const message = `需要 JDK 21，当前：${detected.detail}。请设置 JAVA_HOME 指向 JDK 21。`;
  if (strict) fail(message);
  warn(`${message}（构建时会中止）`);
  return false;
}

function gradleCommand() {
  return path.join(repoRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew");
}

function runCommand(label, command, args, options = {}) {
  info(`执行：${label}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
    windowsHide: false,
    shell: options.shell ?? false,
    env: process.env,
  });
  if (result.error) fail(`${label} 无法执行：${result.error.message}`);
  if (result.status !== 0) fail(`${label} 失败（退出码 ${result.status}）`);
}

/* -------------------------------------------------------------------------- */
/* zip 查找 / 校验                                                             */
/* -------------------------------------------------------------------------- */

function listDistZips() {
  try {
    return fs
      .readdirSync(distDir)
      .filter((name) => /^zcode-ide-.*\.zip$/i.test(name))
      .map((name) => {
        const fullPath = path.join(distDir, name);
        const stat = fs.statSync(fullPath);
        return { name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

function findSourceZip(version) {
  const expected = path.join(distDir, `zcode-ide-${version}.zip`);
  if (fs.existsSync(expected) && fs.statSync(expected).isFile()) {
    return expected;
  }
  const zips = listDistZips();
  if (zips.length === 0) return null;
  return zips[0].fullPath;
}

async function inspectZip(zipPath) {
  let module;
  try {
    module = await import(pathToFileURL(path.join(npmDir, "lib", "manifest.mjs")).href);
  } catch (err) {
    fail(
      `无法加载 zip 校验模块（请先在 scripts/npm 执行 npm install）：${err.message}`,
    );
  }
  try {
    return await module.validatePluginZip(zipPath);
  } catch (err) {
    fail(`插件包校验失败：${err.message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* manifest + 签名                                                             */
/* -------------------------------------------------------------------------- */

function sha256OfFile(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
    stream.on("error", (err) => rejectPromise(err));
  });
}

function parsePrivateKey(raw, label) {
  const pem = raw.includes("-----BEGIN") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let key;
  try {
    key = createPrivateKey(pem.trim());
  } catch (err) {
    fail(`${label} 无法解析为私钥：${err.message}`);
  }
  if (key.asymmetricKeyType !== "ed25519") fail(`${label} 不是 Ed25519 私钥`);
  return key;
}

function loadSigningKey() {
  const envKey = process.env.RUNTIME_SIGNING_KEY?.trim();
  if (envKey) return parsePrivateKey(envKey, "RUNTIME_SIGNING_KEY");

  const keyFile = path.join(os.homedir(), ".zcode", "keys", "runtime-signing-private.pem");
  if (fs.existsSync(keyFile)) {
    return parsePrivateKey(fs.readFileSync(keyFile, "utf8"), keyFile);
  }
  fail(
    "缺少签名私钥：设置环境变量 RUNTIME_SIGNING_KEY，" +
      "或把 Ed25519 私钥放到 ~/.zcode/keys/runtime-signing-private.pem。",
  );
}

function verifyManifestSignature(manifestBytes, signature) {
  const pem = fs.readFileSync(repoPublicKeyPath, "utf8");
  const publicKey = createPublicKey(pem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail(`${path.relative(repoRoot, repoPublicKeyPath)} 不是 Ed25519 公钥`);
  }
  if (!verify(null, manifestBytes, publicKey, Buffer.from(signature, "base64"))) {
    fail("自检失败：仓库公钥无法验证刚生成的 manifest.sig");
  }
}

function checkNpmPublicKey() {
  if (!fs.existsSync(npmPublicKeyPath)) {
    fail(`npm 包缺少内置公钥：${npmPublicKeyPath}`);
  }
  const repoPem = fs.readFileSync(repoPublicKeyPath, "utf8").trim();
  const npmPem = fs.readFileSync(npmPublicKeyPath, "utf8").trim();
  if (repoPem !== npmPem) {
    fail(
      "npm 包内置公钥与仓库公钥不一致：\n" +
        `  npm:  ${npmPublicKeyPath}\n` +
        `  仓库: ${repoPublicKeyPath}\n` +
        "请先同步公钥后再发布。",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 七牛最小实现（Node 内置能力，不引 SDK）                                      */
/* -------------------------------------------------------------------------- */

function urlsafeBase64(input) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function buildUploadToken(config, key) {
  const nowSec = Math.floor(Date.now() / 1000);
  const putPolicy = JSON.stringify({
    scope: `${config.bucket}:${key}`,
    deadline: nowSec + 3600,
    insertOnly: 0,
  });
  const encodedPolicy = urlsafeBase64(putPolicy);
  const encodedSign = urlsafeBase64(
    createHmac("sha1", config.secretKey).update(encodedPolicy).digest(),
  );
  return `${config.accessKey}:${encodedSign}:${encodedPolicy}`;
}

function qboxAuthorization(config, signedText) {
  const signature = urlsafeBase64(
    createHmac("sha1", config.secretKey).update(signedText).digest(),
  );
  return `QBox ${config.accessKey}:${signature}`;
}

function firstDomain(value) {
  if (!Array.isArray(value)) return null;
  const first = value.find((item) => typeof item === "string" && item.length > 0);
  return first === undefined ? null : `https://${first}`;
}

async function fetchRegionHosts(config) {
  const empty = { upload: null, rs: null };
  const requestPath = `/v4/query?ak=${encodeURIComponent(config.accessKey)}&bucket=${encodeURIComponent(config.bucket)}`;
  let response;
  try {
    response = await fetch(`https://uc.qbox.me${requestPath}`, {
      headers: { Authorization: qboxAuthorization(config, `${requestPath}\n`) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    warn(`区域查询失败（退回默认上传域名）：${error.message}`);
    return empty;
  }
  if (!response.ok) {
    warn(`区域查询失败 HTTP ${response.status}（退回默认上传域名）`);
    return empty;
  }
  const parsed = await response.json();
  const host = parsed.hosts?.[0];
  return {
    upload: firstDomain(host?.up?.domains),
    rs: firstDomain(host?.rs?.domains),
  };
}

function deriveRsHost(uploadHost) {
  const region = /(?:up|upload)-([a-z0-9]+)\.qiniup\.com/i.exec(uploadHost)?.[1];
  return region === undefined ? "https://rs.qbox.me" : `https://rs-${region}.qbox.me`;
}

function regionHostFromError(body) {
  return /use ((?:up|upload)-[a-z0-9]+\.qiniup\.com)/i.exec(body)?.[1] ?? null;
}

async function* multipartChunks(head, filePath, tail) {
  yield head;
  const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
  for await (const chunk of stream) yield chunk;
  yield tail;
}

async function uploadMultipart(config, { key, filePath, size, contentType, cacheControl }, uploadHost) {
  const token = buildUploadToken(config, key);
  const boundary = `----zcoderelease${randomBytes(8).toString("hex")}${Date.now().toString(16)}`;
  const filename = key.split("/").pop() ?? "file";
  const cacheControlPart = cacheControl
    ? `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="x:Cache-Control"\r\n\r\n' +
      `${cacheControl}\r\n`
    : "";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="token"\r\n\r\n' +
      `${token}\r\n` +
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="key"\r\n\r\n' +
      `${key}\r\n` +
      cacheControlPart +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const contentLength = head.length + size + tail.length;

  const body = Readable.from(multipartChunks(head, filePath, tail));
  const response = await fetch(`${uploadHost.replace(/\/+$/, "")}/`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(contentLength),
    },
    body,
    duplex: "half",
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const text = await response.text();
  body.destroy();
  return { ok: response.ok, status: response.status, text };
}

async function uploadObject(config, object, uploadHostState) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const startedAt = Date.now();
    const result = await uploadMultipart(config, object, uploadHostState.host);
    if (result.ok) return Date.now() - startedAt;

    const suggested = regionHostFromError(result.text);
    if (suggested !== null && !uploadHostState.regionFixed) {
      uploadHostState.regionFixed = true;
      uploadHostState.host = `https://${suggested}`;
      info(`区域不匹配，按七牛提示切换上传域名 → ${uploadHostState.host}，重试`);
      continue;
    }
    if (result.status === 413 || /RequestEntityTooLarge/i.test(result.text)) {
      fail(
        "HTTP 413 RequestEntityTooLarge：表单上传体积受限，请改用七牛分片上传或 qshell rput。\n" +
          `响应：${result.text.slice(0, 200)}`,
      );
    }
    fail(`上传失败 HTTP ${result.status}：${result.text.slice(0, 200)}`);
  }
  fail("上传失败：重试后仍返回 incorrect region");
}

async function changeMime(config, key, mime, rsHost) {
  const requestPath = `/chgm/${urlsafeBase64(`${config.bucket}:${key}`)}/mime/${urlsafeBase64(mime)}`;
  try {
    const response = await fetch(`${rsHost}${requestPath}`, {
      method: "POST",
      headers: {
        Authorization: qboxAuthorization(config, `${requestPath}\n`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function refreshCdn(config, urls) {
  for (const url of urls) {
    const requestPath = `/refresh/${urlsafeBase64(url)}`;
    try {
      const response = await fetch(`https://fusion.qiniuapi.com${requestPath}`, {
        method: "POST",
        headers: { Authorization: qboxAuthorization(config, `${requestPath}\n`) },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      if (response.ok) info(`CDN 刷新已提交：${url}`);
      else warn(`CDN 刷新失败（HTTP ${response.status}）：${url} ${text.slice(0, 160)}`);
    } catch (error) {
      warn(`CDN 刷新异常：${url}（${error.message}）`);
    }
  }
}

const HEAD_RETRY_DELAYS_MS = [1000, 2000, 4000];

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function verifyRemoteObjectOnce(url, expectedSize) {
  let response;
  try {
    response = await fetch(url, {
      method: "HEAD",
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
  const length = response.headers.get("content-length");
  if (length === null) {
    warn(`HEAD 未返回 Content-Length，跳过大小对账：${url}`);
    return { ok: true };
  }
  if (Number(length) !== expectedSize) {
    return {
      ok: false,
      reason: `大小不一致（期望 ${expectedSize}，实际 ${length}）`,
    };
  }
  return { ok: true };
}

/**
 * HEAD 对账：首次 + 重试 3 次（1s/2s/4s）。
 * 返回 null 表示通过，否则返回最后一次失败原因（由调用方决定致命或仅警告）。
 */
/**
 * 读取 CDN 实际返回的 Cache-Control 与 Age。
 * Age 比对象头更能反映“域名缓存规则是否已生效”：后台把 TTL 设成 1s 时，
 * 对象头可能仍是源站的 1 年，但 Age 会保持很小。
 */
async function readRemoteCacheInfo(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    return {
      cacheControl: response.headers.get("cache-control"),
      age: response.headers.get("age"),
    };
  } catch {
    return null;
  }
}

async function verifyRemoteObject(url, expectedSize, label) {
  const attempts = HEAD_RETRY_DELAYS_MS.length + 1;
  let lastReason = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await verifyRemoteObjectOnce(url, expectedSize);
    if (result.ok) return null;
    lastReason = result.reason;
    if (attempt < attempts) {
      const delay = HEAD_RETRY_DELAYS_MS[attempt - 1];
      warn(
        `${label} HEAD 对账失败（第 ${attempt}/${attempts} 次）：${lastReason}；` +
          `${delay / 1000}s 后重试…`,
      );
      await sleep(delay);
    }
  }
  return lastReason;
}

/* -------------------------------------------------------------------------- */
/* npm                                                                         */
/* -------------------------------------------------------------------------- */

function runNpm(args, { capture = false } = {}) {
  const result = spawnSync("npm", args, {
    cwd: npmDir,
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) fail(`无法执行 npm：${result.error.message}`);
  return result;
}

function ensureNpmVersionAbsent(name, version, registry) {
  info(`检查 npm 远端版本：npm view ${name}@${version} --registry ${registry}`);
  const result = runNpm(["view", `${name}@${version}`, "version", "--registry", registry], {
    capture: true,
  });
  if (result.status === 0) {
    fail(
      `npm 上已存在 ${name}@${version}，同版本不可覆盖。` +
        "请先手动修改 scripts/npm/package.json 的 version 后再发布。",
    );
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/E404|404 Not Found|is not in this registry|ETARGET|No matching version/i.test(output)) {
    info(`npm 远端没有 ${name}@${version}，可以发布。`);
    return;
  }
  fail(`npm view 检查失败（无法确认远端状态，拒绝发布）：${output.trim().slice(0, 300)}`);
}

/* -------------------------------------------------------------------------- */
/* build-only                                                                  */
/* -------------------------------------------------------------------------- */

/** 只构建插件 zip：build-runtime（默认）+ gradlew + 校验 jar 内版本。 */
async function runBuildOnly(args, version) {
  info("build-only：只构建插件 zip，不生成 manifest、不上传、不发 npm。");
  const ignored = [];
  if (args.apply) ignored.push("--apply");
  if (args.push) ignored.push("--push");
  if (args.npm) ignored.push("--npm");
  if (args.noOss) ignored.push("--no-oss");
  if (args.allowHttp) ignored.push("--allow-http");
  if (args.allowDowngrade) ignored.push("--allow-downgrade");
  if (ignored.length > 0) warn(`--build-only 忽略：${ignored.join("、")}`);

  checkJdk({ strict: true });

  if (args.skipRuntime) {
    info("按 --skip-runtime 跳过 runtime 构建");
  } else {
    runCommand("node scripts/build-runtime.mjs", process.execPath, [
      path.join(repoRoot, "scripts", "build-runtime.mjs"),
    ]);
  }

  const gradleArgs = [
    "buildPlugin",
    `-PpluginVersion=${version}`,
    ...(args.bundleRuntime ? ["-PbundleRuntime=true"] : []),
  ];
  runCommand(
    `${gradleCommand()} ${gradleArgs.join(" ")}`,
    gradleCommand(),
    gradleArgs,
    { shell: process.platform === "win32" },
  );

  const zipPath = path.join(distDir, `zcode-ide-${version}.zip`);
  if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
    const available = listDistZips().map((item) => item.name);
    fail(
      `构建后未找到 ${zipPath}。build/distributions 现有：` +
        (available.length ? available.join(", ") : "（空）"),
    );
  }
  const zipInfo = await inspectZip(zipPath);
  if (zipInfo.pluginId !== "dev.zcode.ide") {
    fail(`构建产物插件 id 不是 dev.zcode.ide（实际：${zipInfo.pluginId}）`);
  }
  if (zipInfo.pluginVersion !== version) {
    fail(
      `构建产物版本 ${zipInfo.pluginVersion} 与仓库根 package.json ${version} 不一致；` +
        "请确认 -PpluginVersion 传递与 gradle 配置。",
    );
  }
  info(`build-only 完成：${zipPath}`);
  info(`插件版本=${zipInfo.pluginVersion} size=${zipInfo.size} sha256=${zipInfo.sha256}`);
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.buildOnly
    ? "build-only"
    : !args.apply
      ? "dry-run"
      : args.push
        ? "apply+push"
        : "apply";
  info(`模式：${mode}${args.apply && !args.push ? "（本地执行；远端写入需再加 --push）" : ""}`);

  /* ---------------------------- 1/5 版本与环境 ---------------------------- */
  step(1, "版本与环境检查");

  let npmPkg;
  try {
    npmPkg = JSON.parse(fs.readFileSync(npmPackageJsonPath, "utf8"));
  } catch (err) {
    fail(`无法读取 ${npmPackageJsonPath}：${err.message}`);
  }
  const name = String(npmPkg.name ?? "").trim();
  if (!name) fail("scripts/npm/package.json 缺少 name");
  const npmVersion = String(npmPkg.version ?? "").trim();
  if (!SEMVER_RE.test(npmVersion)) {
    fail(`scripts/npm/package.json 的 version 不是合法 semver：${npmVersion || "(空)"}`);
  }

  let rootPkg;
  try {
    rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  } catch (err) {
    fail(`无法读取仓库根 package.json：${err.message}`);
  }
  const rootVersion = String(rootPkg.version ?? "").trim();
  if (!SEMVER_RE.test(rootVersion)) {
    fail(`仓库根 package.json 的 version 不是合法 semver：${rootVersion || "(空)"}`);
  }
  if (rootVersion !== npmVersion) {
    fail(
      `版本不一致：仓库根 package.json version=${rootVersion}，` +
        `scripts/npm/package.json version=${npmVersion}。` +
        "请先把两处改成同一版本后再发布/构建（npm 包版本与插件版本必须一致）。",
    );
  }
  const version = npmVersion;

  const gradleVersion = readGradlePluginVersion();
  info(`npm 包/插件版本 = ${name}@${version}`);
  info("仓库根 package.json 与 scripts/npm/package.json 版本一致");
  info(`gradle.properties pluginVersion=${gradleVersion}（构建时用 -PpluginVersion=${version} 覆盖）`);
  if (compareVersions(version, gradleVersion) < 0) {
    warn(
      `插件版本 ${version} 低于 gradle.properties 的 ${gradleVersion}；` +
        "本脚本会用 -PpluginVersion 覆盖，仅提示。",
    );
  }

  if (args.buildOnly) {
    await runBuildOnly(args, version);
    return;
  }

  if (!args.skipBuild) {
    checkJdk({ strict: args.apply });
  } else {
    info("--skip-build：跳过 JDK/构建检查");
  }

  const bucket = process.env.QINIU_BUCKET?.trim() || "zcode-ide";
  const domainRaw = process.env.QINIU_DOMAIN?.trim() || "";
  const accessKey = process.env.QINIU_ACCESS_KEY?.trim() || "";
  const secretKey = process.env.QINIU_SECRET_KEY?.trim() || "";
  info(
    `OSS：bucket=${bucket} prefix=${args.prefix} domain=${domainRaw || "(未设置)"} ` +
      `AK/SK=${accessKey && secretKey ? "已设置" : "未设置"}`,
  );
  info(`npm registry：${args.registry}`);
  checkNpmPublicKey();

  if (domainRaw && !domainRaw.startsWith("https://")) {
    if (!(args.allowHttp && domainRaw.startsWith("http://"))) {
      fail(
        `QINIU_DOMAIN 必须以 https:// 开头（HTTP 测试域名联调请显式加 --allow-http），当前：${domainRaw}`,
      );
    }
    warn("使用 HTTP 测试域名，仅限联调；生产必须使用 https:// 自有域名。");
  }
  const domain = domainRaw.replace(/\/+$/, "");

  /* ---------------------------- 2/5 构建或复用 ---------------------------- */
  step(2, args.skipBuild ? "复用现有插件包" : "构建插件");

  const buildZipName = `zcode-ide-${version}.zip`;
  let sourceZip = null;
  let zipInfo = null;

  if (args.skipBuild) {
    if (args.bundleRuntime) warn("--skip-build 时忽略 --bundle-runtime");
    if (args.skipRuntime) warn("--skip-build 时忽略 --skip-runtime");
    sourceZip = findSourceZip(version);
    if (!sourceZip) {
      fail(
        `${distDir} 下没有 zcode-ide-*.zip。请去掉 --skip-build 重新构建。`,
      );
    }
    info(`复用：${sourceZip}`);
    zipInfo = await inspectZip(sourceZip);
    info(`zip 校验通过：id=${zipInfo.pluginId} version=${zipInfo.pluginVersion}`);

    if (zipInfo.pluginVersion !== version) {
      const message =
        `现有 zip 版本是 ${zipInfo.pluginVersion}，仓库根 package.json 是 ${version}；` +
        "去掉 --skip-build 重新构建。";
      if (args.allowDowngrade) {
        warn(`${message}（--allow-downgrade：将按 package.json 版本命名产物，仅联调）`);
      } else {
        fail(message);
      }
    }
  } else {
    const runtimeArgs = args.skipRuntime
      ? null
      : [path.join(repoRoot, "scripts", "build-runtime.mjs")];
    const gradleArgs = [
      "buildPlugin",
      `-PpluginVersion=${version}`,
      ...(args.bundleRuntime ? ["-PbundleRuntime=true"] : []),
    ];

    if (runtimeArgs) info("将执行：node scripts/build-runtime.mjs");
    else if (args.skipRuntime) info("按 --skip-runtime 跳过 runtime 构建");
    info(`将执行：${gradleCommand()} ${gradleArgs.join(" ")}`);

    if (!args.apply) {
      sourceZip = path.join(distDir, buildZipName);
      info(`期望产物：${sourceZip}（dry-run 不构建）`);
    } else {
      if (runtimeArgs) {
        runCommand("node scripts/build-runtime.mjs", process.execPath, runtimeArgs);
      }
      runCommand(gradleCommand(), gradleCommand(), gradleArgs, {
        shell: process.platform === "win32",
      });
      sourceZip = path.join(distDir, buildZipName);
      if (!fs.existsSync(sourceZip) || !fs.statSync(sourceZip).isFile()) {
        const available = listDistZips().map((item) => item.name);
        fail(
          `构建后未找到 ${sourceZip}。build/distributions 现有：` +
            (available.length ? available.join(", ") : "（空）"),
        );
      }
      zipInfo = await inspectZip(sourceZip);
      if (zipInfo.pluginVersion !== version) {
        fail(
          `构建产物版本 ${zipInfo.pluginVersion} 与仓库根 package.json ${version} 不一致；` +
            "请确认 -PpluginVersion 传递与 gradle 配置。",
        );
      }
      info(`zip 校验通过：id=${zipInfo.pluginId} version=${zipInfo.pluginVersion}`);
    }
  }

  // 内容寻址：同一版本重新构建会得到新的 sha12，zip key 随之改变，旧 zip 保留。
  // dry-run 且未构建时 sha 未知，用占位符展示路径模式。
  const sha12 = zipInfo ? zipInfo.sha256.slice(0, 12) : "<sha12>";
  const archiveName = `zcode-ide-${version}-${sha12}.zip`;
  const archivePath = `${args.prefix}/plugin/${args.channel}/${version}/${archiveName}`;
  info(`zip 对象（内容寻址）：${archivePath}`);

  /* ---------------------------- 3/5 manifest + 签名 ---------------------------- */
  step(3, "生成 manifest + Ed25519 签名");

  if (zipInfo) {
    info(`zip：${sourceZip}`);
    info(`size=${zipInfo.size} sha256=${zipInfo.sha256}`);
  }

  const manifestPath = path.join(args.out, "manifest.json");
  const sigPath = path.join(args.out, "manifest.sig");
  const releaseZipPath = path.join(args.out, archiveName);
  let manifest = {
    schemaVersion: 1,
    channel: args.channel,
    pluginVersion: version,
    archivePath,
    sha256: zipInfo?.sha256 ?? "<构建后计算>",
    size: zipInfo?.size ?? 0,
    builtAt: zipInfo ? new Date(fs.statSync(sourceZip).mtimeMs).toISOString() : "<构建后计算>",
  };
  let signature = null;

  if (!args.apply) {
    info(`将写入：${manifestPath}`);
    info(`将写入：${sigPath}`);
    info("manifest 预览：");
    console.log(`${JSON.stringify(manifest, null, 2)}`);
    info("dry-run 不生成文件。");
  } else {
    if (!zipInfo) fail("缺少已校验的 zip，无法生成 manifest");
    try {
      await fs.promises.mkdir(args.out, { recursive: true });
      for (const entry of await fs.promises.readdir(args.out, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (
          entry.name !== archiveName &&
          (entry.name.endsWith(".zip") ||
            entry.name === "manifest.json" ||
            entry.name === "manifest.sig")
        ) {
          await fs.promises.rm(path.join(args.out, entry.name), { force: true });
        }
      }
      await fs.promises.copyFile(sourceZip, releaseZipPath);
    } catch (err) {
      fail(`准备发布目录 ${args.out} 失败：${err.message}`);
    }

    const copiedSha256 = await sha256OfFile(releaseZipPath);
    const copiedSize = fs.statSync(releaseZipPath).size;
    if (copiedSha256 !== zipInfo.sha256 || copiedSize !== zipInfo.size) {
      fail("复制到发布目录后 sha256/size 与源 zip 不一致，请检查磁盘。");
    }

    manifest = {
      schemaVersion: 1,
      channel: args.channel,
      pluginVersion: version,
      archivePath,
      sha256: copiedSha256,
      size: copiedSize,
      builtAt: new Date(fs.statSync(sourceZip).mtimeMs).toISOString(),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.promises.writeFile(manifestPath, manifestBytes);

    const privateKey = loadSigningKey();
    signature = sign(null, manifestBytes, privateKey).toString("base64");
    await fs.promises.writeFile(sigPath, signature);

    verifyManifestSignature(manifestBytes, signature);

    info(`发布目录：${args.out}`);
    info(`manifest：${manifestPath}`);
    info(`签名：${sigPath}`);
    info(`pluginVersion=${manifest.pluginVersion} archivePath=${manifest.archivePath}`);
    info(`size=${manifest.size} sha256=${manifest.sha256}`);
    info("manifest.sig 已生成并通过仓库公钥自检。");
  }

  /* ---------------------------- 4/5 上传 OSS ---------------------------- */
  step(4, "上传七牛 OSS（zip → 版本化 manifest → 稳定指针）");

  const channelDir = `${args.prefix}/plugin/${args.channel}`;
  const versionDir = `${channelDir}/${version}`;
  const sigSize = signature ? Buffer.byteLength(signature) : 0;
  const sigSha256 = signature
    ? createHash("sha256").update(Buffer.from(signature, "utf8")).digest("hex")
    : "<签名后计算>";
  const manifestFileBytes = args.apply ? fs.readFileSync(manifestPath) : null;
  const manifestFileSize = manifestFileBytes ? manifestFileBytes.length : 0;
  const manifestFileSha256 = manifestFileBytes
    ? createHash("sha256").update(manifestFileBytes).digest("hex")
    : "<生成后计算>";

  const objects = [
    {
      key: archivePath,
      filePath: releaseZipPath,
      size: manifest.size,
      sha256: manifest.sha256,
      contentType: "application/zip",
      cacheControl: "public, max-age=31536000, immutable",
      label: "zip（内容寻址）",
      headPolicy: "fatal",
    },
    {
      key: `${versionDir}/manifest.sig`,
      filePath: sigPath,
      size: sigSize,
      sha256: sigSha256,
      contentType: "application/octet-stream",
      cacheControl: "no-cache",
      label: "版本化 manifest.sig",
      headPolicy: "fatal",
    },
    {
      key: `${versionDir}/manifest.json`,
      filePath: manifestPath,
      size: manifestFileSize,
      sha256: manifestFileSha256,
      contentType: "application/json",
      cacheControl: "no-cache",
      label: "版本化 manifest.json",
      headPolicy: "fatal",
    },
    {
      key: `${channelDir}/manifest.sig`,
      filePath: sigPath,
      size: sigSize,
      sha256: sigSha256,
      contentType: "application/octet-stream",
      cacheControl: "no-cache",
      label: "稳定 manifest.sig（兼容旧版）",
      headPolicy: "warn",
    },
    {
      key: `${channelDir}/manifest.json`,
      filePath: manifestPath,
      size: manifestFileSize,
      sha256: manifestFileSha256,
      contentType: "application/json",
      cacheControl: "no-cache",
      label: "稳定 manifest.json（兼容旧版）",
      headPolicy: "warn",
    },
  ];

  info("上传计划：");
  for (const [index, object] of objects.entries()) {
    console.log(`  ${index + 1}. key=${object.key}  [${object.label}]`);
    console.log(
      domain
        ? `     url=${domain}/${object.key}`
        : "     url=（QINIU_DOMAIN 未设置，无法生成完整 URL）",
    );
    console.log(
      `     ${object.size || "?"} bytes  sha256=${object.sha256}  ` +
        `cache-control=${object.cacheControl}  head=${object.headPolicy}`,
    );
  }

  if (args.noOss) {
    info("按 --no-oss 跳过七牛上传。");
  } else if (!args.apply) {
    info("dry-run：未上传。");
  } else if (!args.push) {
    info("本地产物已生成；未上传（远端写入需 --apply --push）。");
  } else {
    const missingEnv = [
      ["QINIU_ACCESS_KEY", accessKey],
      ["QINIU_SECRET_KEY", secretKey],
      ["QINIU_DOMAIN", domain],
    ]
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missingEnv.length > 0) fail(`--apply --push 需要环境变量：${missingEnv.join(", ")}`);

    const config = { accessKey, secretKey, bucket };
    const uploadHostState = {
      host: process.env.QINIU_UPLOAD_HOST?.trim() || "https://up-z2.qiniup.com",
      regionFixed: false,
    };
    const hosts = await fetchRegionHosts(config);
    if (hosts.upload) uploadHostState.host = hosts.upload;
    const rsHost = hosts.rs ?? deriveRsHost(uploadHostState.host);
    info(`上传域名=${uploadHostState.host}  rs 域名=${rsHost}`);

    const stableObjects = [];
    for (const object of objects) {
      if (!fs.existsSync(object.filePath)) fail(`缺少待上传文件：${object.filePath}`);
      const elapsedMs = await uploadObject(config, object, uploadHostState);
      info(
        `已上传：${object.key}  ${object.size} bytes  ${(elapsedMs / 1000).toFixed(1)}s` +
          `（${object.label}）`,
      );

      if (object.key === archivePath) {
        const url = `${domain}/${object.key}`;
        const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
        const remoteMime = head.headers.get("content-type")?.split(";")[0]?.trim();
        if (head.ok && remoteMime !== object.contentType) {
          info(`远端 Content-Type=${remoteMime ?? "（空）"}，用 chgm 修正为 ${object.contentType}`);
          const fixed = await changeMime(config, object.key, object.contentType, rsHost);
          if (!fixed) fail(`chgm 修正 MIME 失败：${object.key}`);
        }
      }

      if (object.headPolicy === "fatal") {
        const url = `${domain}/${object.key}`;
        const reason = await verifyRemoteObject(url, object.size, object.label);
        if (reason) {
          fail(
            `${object.label} HEAD 对账失败（已重试 3 次）：${reason}。对象已上传：${url}`,
          );
        }
        info(`${object.label} HEAD 对账通过：${object.key}（${object.size} bytes）`);
      } else {
        stableObjects.push(object);
      }
    }

    // 稳定指针兼容旧版安装器：边缘可能滞后，重试后仍不一致只警告，不中止。
    for (const object of stableObjects) {
      const url = `${domain}/${object.key}`;
      const reason = await verifyRemoteObject(url, object.size, object.label);
      if (reason) {
        warn(
          `${object.label} HEAD 对账未通过（已重试 3 次）：${reason}。` +
            "对象已上传，版本化清单指向不可变 zip；稳定指针可能滞后，请在生产 CDN 刷新缓存" +
            "（测试域名可能不支持）。",
        );
      } else {
        info(`HEAD 对账通过：${object.key}（${object.size} bytes）`);
      }
      const cache = await readRemoteCacheInfo(url);
      if (cache?.cacheControl || cache?.age) {
        const age = Number(cache.age);
        const ageKnown = Number.isFinite(age);
        const noCacheHeader = /no-cache|no-store|max-age=0/i.test(cache.cacheControl ?? "");
        if (ageKnown && age <= 5) {
          info(
            `CDN 缓存 Age=${age}s（Cache-Control=${cache.cacheControl ?? "无"}），短 TTL 生效。`,
          );
        } else if (!noCacheHeader) {
          warn(
            `CDN 缓存仍偏长（Cache-Control=${cache.cacheControl ?? "无"}，` +
              `Age=${cache.age ?? "无"}）：${path.posix.basename(object.key)}。` +
              "若后台已设短 TTL，请先刷新该 URL 的旧缓存条目；否则请在 CDN 控制台把 " +
              "manifest/sig 路径设为不缓存（TTL=0）。",
          );
        }
      }
    }

    // 版本化清单与 zip 都是新 key，无需刷新；只刷新稳定指针（兼容旧版）。
    await refreshCdn(
      config,
      stableObjects.map((object) => `${domain}/${object.key}`),
    );
  }

  /* ---------------------------- 5/5 npm 发布 ---------------------------- */
  step(5, "发布 npm 小包（仅 --npm）");

  const versionedManifestUrl = domain
    ? `${domain}/${channelDir}/${version}/manifest.json`
    : `（QINIU_DOMAIN 未设置）本地 ${manifestPath}`;
  const stableManifestUrl = domain
    ? `${domain}/${channelDir}/manifest.json`
    : `（QINIU_DOMAIN 未设置）本地 ${manifestPath}`;

  if (!args.npm) {
    info("未指定 --npm，跳过 npm 发布。");
  } else if (!args.apply) {
    info(`将执行：npm view ${name}@${version} version --registry ${args.registry}`);
    info(`将执行：npm publish --registry ${args.registry}（cwd=scripts/npm）`);
    info("dry-run：未发布。");
  } else if (!args.push) {
    info(`将执行：npm view ${name}@${version} version --registry ${args.registry}`);
    info(`将执行：npm publish --registry ${args.registry}（cwd=scripts/npm）`);
    info("未发布（远端写入需 --apply --push）。");
  } else {
    if (!fs.existsSync(path.join(npmDir, "package.json"))) fail("找不到 scripts/npm/package.json");
    ensureNpmVersionAbsent(name, npmVersion, args.registry);
    info(`执行：npm publish --registry ${args.registry}（cwd=scripts/npm）`);
    const result = runNpm(["publish", "--registry", args.registry]);
    if (result.status !== 0) fail(`npm publish 失败（退出码 ${result.status}）`);
    info(`npm 已发布：${name}@${npmVersion}`);
  }

  /* ---------------------------- 汇总 ---------------------------- */
  info("汇总：");
  info(`  版本：${name}@${version}（npm 包 / 插件 / OSS 路径 / manifest 同源）`);
  info(`  zip：${sourceZip ?? `${distDir}/${archiveName}（未构建）`}` +
    `${!args.apply && !args.skipBuild ? "（dry-run 未构建）" : ""}`);
  info(`  manifest（版本化）：${versionedManifestUrl}`);
  info(`  稳定指针（兼容旧版）：${stableManifestUrl}`);
  if (args.noOss) info("  OSS：已跳过（--no-oss）");
  else if (!args.apply) info("  OSS：dry-run，未上传");
  else if (!args.push) info("  OSS：本地已生成，未上传（需 --apply --push）");
  else info("  OSS：已上传");
  if (!args.npm) info("  npm：已跳过（未指定 --npm）");
  else if (!args.apply || !args.push) info("  npm：未发布（需 --apply --push）");
  else info(`  npm：已发布 ${name}@${npmVersion}`);
}

main().catch((err) => fail(err?.message || String(err)));
