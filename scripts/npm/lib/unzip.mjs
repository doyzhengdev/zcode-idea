/**
 * 解压插件包到 plugins 目录。
 *
 * 行为：先删 `<pluginsDir>/zcode-ide`，再把 zip 中 `zcode-ide/` 前缀去掉后解压到
 * `<pluginsDir>`，最终形成 `<pluginsDir>/zcode-ide/...`。
 * 保留 unix 权限位；失败时清理半成品目录。
 */

import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { InstallError } from "./errors.mjs";
import { formatBytes, info } from "./log.mjs";
import {
  isSymlinkEntry,
  iterateZip,
  openReadStream,
  openZip,
  validateZipEntryName,
} from "./manifest.mjs";

export const PLUGIN_DIR_NAME = "zcode-ide";

/**
 * @param {object} params
 * @param {string} params.zipPath
 * @param {string} params.pluginsDir 目标 plugins 目录
 * @param {number} [params.expectedEntries] 用于进度显示
 * @param {number} [params.expectedBytes]
 */
export async function extractPluginZip({
  zipPath,
  pluginsDir,
  expectedEntries = 0,
  expectedBytes = 0,
}) {
  try {
    await fsp.mkdir(pluginsDir, { recursive: true });
  } catch (err) {
    throw new InstallError(`无法创建目标目录 ${pluginsDir}：${err.message}`);
  }

  const pluginDir = path.join(pluginsDir, PLUGIN_DIR_NAME);
  try {
    await fsp.rm(pluginDir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    throw new InstallError(
      `无法删除旧版本目录 ${pluginDir}：${err.message}。请关闭占用该目录的 IDE 后重试。`,
    );
  }

  const progress = createProgress(expectedEntries, expectedBytes);
  let entries = 0;
  let files = 0;
  let bytes = 0;
  const zip = await openZip(zipPath);

  try {
    await iterateZip(zip, async (entry) => {
      const nameError = validateZipEntryName(entry.fileName);
      if (nameError) {
        throw new InstallError(
          `插件包内含不安全条目「${entry.fileName}」：${nameError}。已中止安装。`,
        );
      }
      if (isSymlinkEntry(entry)) {
        throw new InstallError(`插件包内含符号链接条目「${entry.fileName}」，拒绝安装。`);
      }

      entries += 1;
      const destination = safeJoin(pluginsDir, entry.fileName);

      if (entry.fileName === PLUGIN_DIR_NAME || entry.fileName.endsWith("/")) {
        await fsp.mkdir(destination, { recursive: true });
      } else {
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        const source = await openReadStream(zip, entry);
        await pipeline(source, createWriteStream(destination, { mode: 0o644 }));
        const mode = (entry.externalFileAttributes >>> 16) & 0o777;
        if (mode) {
          try {
            await fsp.chmod(destination, mode);
          } catch {
            /* Windows 上 chmod 能力有限，忽略 */
          }
        }
        files += 1;
        bytes += entry.uncompressedSize;
      }
      progress.update(entries, files, bytes);
    });
  } catch (err) {
    progress.finish();
    try {
      await fsp.rm(pluginDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    if (err instanceof InstallError) throw err;
    throw new InstallError(
      `解压失败（${zipPath} → ${pluginsDir}）：${err.message}。已清理半成品目录。`,
    );
  } finally {
    try {
      zip.close();
    } catch {
      /* 已关闭 */
    }
  }

  progress.finish();
  return { pluginDir, entries, files, bytes };
}

function safeJoin(root, entryName) {
  const rootResolved = path.resolve(root);
  const destination = path.resolve(rootResolved, ...entryName.split("/"));
  const relative = path.relative(rootResolved, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new InstallError(`拒绝越界解压路径：${entryName}`);
  }
  return destination;
}

function createProgress(totalEntries, totalBytes) {
  const tty = Boolean(process.stdout.isTTY);
  let lastBucket = -1;
  let printed = false;
  return {
    update(entries, files, bytes) {
      const percent = totalEntries > 0 ? Math.min(100, Math.floor((entries / totalEntries) * 100)) : 0;
      if (tty) {
        printed = true;
        process.stdout.write(
          `\r[zcode-idea] 解压中 ${String(percent).padStart(3, " ")}%｜文件 ${files}` +
            (expectedBytesSuffix(totalBytes, bytes)) +
            "    ",
        );
      } else {
        const bucket = Math.floor(percent / 10);
        if (bucket > lastBucket) {
          lastBucket = bucket;
          info(`解压进度 ${percent}%（${files} 个文件，${formatBytes(bytes)}）`);
        }
      }
    },
    finish() {
      if (tty && printed) process.stdout.write("\n");
    },
  };
}

function expectedBytesSuffix(totalBytes, bytes) {
  if (!totalBytes) return `｜已写入 ${formatBytes(bytes)}`;
  return `｜已写入 ${formatBytes(bytes)}/${formatBytes(totalBytes)}`;
}
