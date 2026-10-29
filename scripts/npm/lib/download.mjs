/**
 * 插件包下载与本地缓存。
 *
 * 缓存位置：`${ZCODE_DATA_BASE_DIR:-~/.zcode}/ide/plugin-cache/<sha256>.zip`
 * - 命中且 sha256/size 一致 → 直接复用；
 * - 未命中 → 下载到 `<sha256>.zip.part`，校验后原子改名为正式缓存；
 * - 下载失败重试 3 次（退避 0.5s/1s），最终失败给出可操作提示（可用 --zip 离线）。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { InstallError } from "./errors.mjs";
import { formatBytes, info, warn } from "./log.mjs";
import { sha256File } from "./manifest.mjs";

const DOWNLOAD_TIMEOUT_MS = 60 * 60_000;
const RETRY_BACKOFF_MS = 500;
// 只有 sha256 命名的文件才是缓存产物；其它 *.zip 可能是用户手工放入的文件，不能碰。
const CACHE_FILE_PATTERN = /^([0-9a-f]{64})\.zip(\.part)?$/i;

/** 插件缓存目录。 */
export function getPluginCacheDir(env = process.env) {
  const override = env.ZCODE_DATA_BASE_DIR?.trim();
  const root = override ? path.resolve(override) : path.join(os.homedir(), ".zcode");
  return path.join(root, "ide", "plugin-cache");
}

export function getCachedArchivePath(sha256, env = process.env) {
  return path.join(getPluginCacheDir(env), `${sha256}.zip`);
}

/** 仅按大小判断缓存是否可能存在（dry-run 提示用，不做 sha 校验）。 */
export function isCachePresent(sha256, size, env = process.env) {
  try {
    const stat = fs.statSync(getCachedArchivePath(sha256, env));
    return stat.isFile() && stat.size === size;
  } catch {
    return false;
  }
}

/**
 * 清理插件包缓存。
 *
 * 只处理缓存目录下以 sha256 命名的 `<64位十六进制>.zip` 与下载残留
 * `<64位十六进制>.zip.part`：
 * - `keep` 中的 sha256（大小写不敏感）对应的 zip 保留；
 * - 其余缓存 zip 与全部缓存 `.part` 删除（`keep` 为空表示全部清理）；
 * - 其它文件与子目录（包括非 sha256 命名的 `*.zip`）一律不动；
 * - 单个文件删除失败只记入 `failed`，不中断整体清理。
 *
 * 目录不存在时返回空结果，不抛错；本函数不打印日志，由调用方决定输出。
 *
 * @param {object} [params]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {string[]} [params.keep] 需要保留的 sha256 列表
 * @param {boolean} [params.dryRun] 只扫描不删除（CLI dry-run 提示用）
 * @returns {Promise<{
 *   removed: Array<{path: string, size: number}>,
 *   freedBytes: number,
 *   keptCount: number,
 *   failed: Array<{path: string, error: string}>,
 * }>}
 */
export async function prunePluginCache({ env = process.env, keep = [], dryRun = false } = {}) {
  const keepSet = new Set(
    (Array.isArray(keep) ? keep : [])
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const cacheDir = getPluginCacheDir(env);

  let entries;
  try {
    entries = await fsp.readdir(cacheDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { removed: [], freedBytes: 0, keptCount: 0, failed: [] };
    }
    throw new InstallError(`无法读取插件缓存目录 ${cacheDir}：${err.message}`);
  }

  const result = { removed: [], freedBytes: 0, keptCount: 0, failed: [] };
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .map((name) => ({ name, match: CACHE_FILE_PATTERN.exec(name) }))
    .filter((item) => item.match)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const { name, match } of candidates) {
    const sha256 = match[1].toLowerCase();
    const isPart = Boolean(match[2]);
    // 只有正式 zip 能按 sha256 保留；.part 是下载残留，一律清掉。
    if (!isPart && keepSet.has(sha256)) {
      result.keptCount += 1;
      continue;
    }

    const filePath = path.join(cacheDir, name);
    let size = 0;
    try {
      size = (await fsp.stat(filePath)).size;
    } catch {
      // 读不到大小不影响删除，removed 里按 0 记录。
    }

    if (dryRun) {
      result.removed.push({ path: filePath, size });
      result.freedBytes += size;
      continue;
    }

    try {
      await fsp.rm(filePath, { force: true });
      result.removed.push({ path: filePath, size });
      result.freedBytes += size;
    } catch (err) {
      result.failed.push({ path: filePath, error: err?.message ?? String(err) });
    }
  }

  return result;
}

/**
 * 确保插件包存在且通过 sha256/size 校验。
 *
 * @param {object} params
 * @param {string} params.archiveUrl
 * @param {string} params.sha256
 * @param {number} params.size
 * @param {number} [params.retries]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {Promise<{zipPath: string, fromCache: boolean}>}
 */
export async function ensurePluginArchive({
  archiveUrl,
  sha256,
  size,
  retries = 3,
  env = process.env,
}) {
  if (!archiveUrl) throw new InstallError("缺少插件包下载地址");
  if (!/^[0-9a-f]{64}$/i.test(String(sha256 ?? ""))) {
    throw new InstallError("插件包 sha256 不合法，拒绝下载");
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw new InstallError(`插件包大小不合法：${size}`);
  }

  const cacheDir = getPluginCacheDir(env);
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
  } catch (err) {
    throw new InstallError(`无法创建插件缓存目录 ${cacheDir}：${err.message}`);
  }

  const finalPath = path.join(cacheDir, `${sha256}.zip`);
  const partPath = `${finalPath}.part`;

  if (isCachePresent(sha256, size, env)) {
    const cachedSha256 = await sha256File(finalPath).catch(() => null);
    if (cachedSha256 === sha256.toLowerCase()) {
      info(`使用本地缓存插件包：${finalPath}`);
      return { zipPath: finalPath, fromCache: true };
    }
    warn(`本地缓存 sha256 不一致，删除后重新下载：${finalPath}`);
    await fsp.rm(finalPath, { force: true }).catch(() => {});
  } else if (fs.existsSync(finalPath)) {
    warn(`本地缓存大小不一致，删除后重新下载：${finalPath}`);
    await fsp.rm(finalPath, { force: true }).catch(() => {});
  }

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const received = await downloadToFile(archiveUrl, partPath, size);
      if (received !== size) {
        throw new Error(`下载大小不一致：期望 ${size} 字节，实际 ${received} 字节`);
      }
      const actualSha256 = await sha256File(partPath);
      if (actualSha256 !== sha256.toLowerCase()) {
        throw new Error(`下载后 sha256 校验失败：期望 ${sha256}，实际 ${actualSha256}`);
      }
      await fsp.rename(partPath, finalPath);
      info(`插件包下载并校验完成：${finalPath}`);
      return { zipPath: finalPath, fromCache: false };
    } catch (err) {
      lastError = err;
      await fsp.rm(partPath, { force: true }).catch(() => {});
      if (attempt < retries) {
        const delay = RETRY_BACKOFF_MS * attempt;
        warn(
          `下载失败（第 ${attempt}/${retries} 次）：${err?.message ?? "未知错误"}；` +
            `${delay}ms 后重试…`,
        );
        await sleep(delay);
      }
    }
  }

  throw new InstallError(
    `下载插件包失败（已重试 ${retries} 次）：${lastError?.message ?? "未知错误"}。` +
      "请检查网络或稍后重试；离线环境可用 --zip <本地 zip> 安装。",
  );
}

async function downloadToFile(archiveUrl, destination, expectedSize) {
  const response = await fetch(archiveUrl, {
    headers: {
      "User-Agent": "zcode-idea-installer",
      Accept: "application/zip, application/octet-stream",
    },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`插件包不存在（HTTP 404）：${archiveUrl}`);
    }
    throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`);
  }
  if (!response.body) throw new Error("下载响应没有响应体");

  const headerSize = Number(response.headers.get("content-length")) || 0;
  const total = expectedSize > 0 ? expectedSize : headerSize;
  const progress = createDownloadProgress(total);
  const startedAt = Date.now();
  let received = 0;

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      progress.update(received, startedAt);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      fs.createWriteStream(destination),
    );
  } finally {
    progress.finish();
  }
  return received;
}

function createDownloadProgress(totalBytes) {
  const tty = Boolean(process.stdout.isTTY);
  let lastBucket = -1;
  let lastPrintAt = 0;
  let printedTty = false;

  return {
    update(received, startedAt) {
      const percent = totalBytes > 0 ? Math.min(100, Math.floor((received / totalBytes) * 100)) : 0;
      const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
      const speed = received / elapsedSeconds;

      if (tty) {
        const now = Date.now();
        if (percent < 100 && now - lastPrintAt < 100) return;
        lastPrintAt = now;
        printedTty = true;
        process.stdout.write(
          `\r[zcode-idea] 下载中 ${String(percent).padStart(3, " ")}%｜` +
            `${formatBytes(received)}/${formatBytes(totalBytes)}｜` +
            `${formatBytes(speed)}/s    `,
        );
        return;
      }

      const bucket = Math.floor(percent / 10);
      if (bucket > lastBucket) {
        lastBucket = bucket;
        info(
          `下载进度 ${percent}%（${formatBytes(received)}/${formatBytes(totalBytes)}，` +
            `${formatBytes(speed)}/s）`,
        );
      }
    },
    finish() {
      if (tty && printedTty) process.stdout.write("\n");
    },
  };
}
