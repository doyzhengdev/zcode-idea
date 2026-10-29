/**
 * 插件 zip 的结构校验（下载完成 / 使用 --zip 时、解压之前执行）。
 *
 * 职责边界：
 * - 本模块只校验 zip 自身：sha256/size、条目安全性、主 jar 与 plugin.xml、runtime 完整性；
 * - 远端 manifest 的验签与字段校验在 remote.mjs；
 * - manifest 签名通过后，zip 的 sha256/size 来自受信任的 manifest，本模块负责对账。
 *
 * 安全策略：拒绝绝对路径、`..`、反斜杠、符号链接、不在 zcode-ide/ 下的条目、重复文件条目。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import yauzl from "yauzl";
import { InstallError } from "./errors.mjs";

export const PACKAGE_PREFIX = "zcode-ide/";
export const PLUGIN_ID = "dev.zcode.ide";

/* -------------------------------------------------------------------------- */
/* zip 读取工具                                                                */
/* -------------------------------------------------------------------------- */

export function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) reject(new InstallError(`无法打开插件包 ${zipPath}：${err.message}。文件可能损坏。`));
      else resolve(zip);
    });
  });
}

export function openZipFromBuffer(buffer, label = "jar") {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) reject(new InstallError(`无法读取 ${label}：${err.message}`));
      else resolve(zip);
    });
  });
}

export function openReadStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) reject(new InstallError(`读取 zip 条目 ${entry.fileName} 失败：${err.message}`));
      else resolve(stream);
    });
  });
}

export function readEntryBuffer(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) {
        reject(new InstallError(`读取 zip 条目 ${entry.fileName} 失败：${err.message}`));
        return;
      }
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", (streamErr) =>
        reject(new InstallError(`读取 zip 条目 ${entry.fileName} 失败：${streamErr.message}`)),
      );
    });
  });
}

/**
 * 顺序遍历 zip 条目。handler 抛错会终止遍历。
 * 返回遍历到的条目总数。zip 由调用方负责关闭（遍历结束后仍可 openReadStream）。
 */
export function iterateZip(zip, handler) {
  return new Promise((resolve, reject) => {
    let count = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    zip.on("error", (err) =>
      finish(
        reject,
        new InstallError(`插件包内含不安全条目或已损坏（${err.message}）。已中止安装。`),
      ),
    );
    zip.on("end", () => finish(resolve, count));
    zip.on("entry", (entry) => {
      const index = count;
      count += 1;
      Promise.resolve()
        .then(() => handler(entry, index))
        .then(() => {
          if (!settled) zip.readEntry();
        })
        .catch((err) => finish(reject, err));
    });
    zip.readEntry();
  });
}

/* -------------------------------------------------------------------------- */
/* 条目安全校验                                                                */
/* -------------------------------------------------------------------------- */

/** 返回错误原因（中文），安全时返回 null。 */
export function validateZipEntryName(name) {
  if (typeof name !== "string" || !name) return "条目名为空";
  if (name.includes("\0")) return "条目名包含空字符";
  if (name.includes("\\")) return "条目名包含反斜杠（Windows 路径写法）";
  if (name.startsWith("/")) return "绝对路径";
  if (/^[A-Za-z]:/.test(name)) return "带盘符的绝对路径";
  const segments = name.split("/");
  if (segments.some((segment) => segment === "..")) return "路径包含 ..（zip-slip）";
  if (name !== "zcode-ide" && !name.startsWith(PACKAGE_PREFIX)) {
    return `不在 ${PACKAGE_PREFIX} 目录下`;
  }
  return null;
}

/** zip 条目是否是符号链接（unix mode 高 16 位中的文件类型位）。 */
export function isSymlinkEntry(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function isDirectoryEntry(entry) {
  return entry.fileName.endsWith("/");
}

/* -------------------------------------------------------------------------- */
/* 校验                                                                        */
/* -------------------------------------------------------------------------- */

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(new InstallError(`读取 ${filePath} 失败：${err.message}`)));
  });
}

/**
 * 校验插件 zip。
 *
 * @param {string} zipPath
 * @param {object} [options]
 * @param {string} [options.expectedSha256] 来自已验签 manifest 的 sha256
 * @param {number} [options.expectedSize]   来自已验签 manifest 的 size
 * @param {string} [options.expectedVersion] 来自已验签 manifest 的 pluginVersion
 * @returns {Promise<object>} zip 摘要信息（供解压进度与汇总使用）
 */
export async function validatePluginZip(zipPath, options = {}) {
  const { expectedSha256, expectedSize, expectedVersion } = options;

  let stat;
  try {
    stat = await fsp.stat(zipPath);
  } catch (err) {
    throw new InstallError(`插件包不存在或不可读：${zipPath}（${err.message}）`);
  }
  if (!stat.isFile()) {
    throw new InstallError(`插件包不是文件：${zipPath}`);
  }
  if (expectedSize !== undefined && expectedSize !== null && stat.size !== Number(expectedSize)) {
    throw new InstallError(
      `插件包大小校验失败（期望 ${expectedSize} 字节，实际 ${stat.size} 字节）：${zipPath}。` +
        "请重新下载，或检查远端产物是否被替换。",
    );
  }

  const actualSha256 = await sha256File(zipPath);
  if (
    expectedSha256 &&
    actualSha256.toLowerCase() !== String(expectedSha256).toLowerCase()
  ) {
    throw new InstallError(
      `插件包 sha256 校验失败（期望 ${expectedSha256}，实际 ${actualSha256}）：${zipPath}。` +
        "请重新下载，或检查远端产物是否被篡改。",
    );
  }

  const zip = await openZip(zipPath);
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  let jarEntry = null;
  let hasRuntime = false;
  let hasRuntimeIndex = false;
  const seenFiles = new Set();
  let pluginInfo = null;

  try {
    await iterateZip(zip, async (entry) => {
      entryCount += 1;
      const nameError = validateZipEntryName(entry.fileName);
      if (nameError) {
        throw new InstallError(
          `插件包内含不安全条目「${entry.fileName}」：${nameError}。已中止安装。`,
        );
      }
      if (isSymlinkEntry(entry)) {
        throw new InstallError(`插件包内含符号链接条目「${entry.fileName}」，出于安全考虑拒绝安装。`);
      }
      if (!isDirectoryEntry(entry)) {
        if (seenFiles.has(entry.fileName)) {
          throw new InstallError(`插件包内含重复文件条目「${entry.fileName}」，拒绝解压。`);
        }
        seenFiles.add(entry.fileName);
        fileCount += 1;
        totalBytes += entry.uncompressedSize;
      }
      if (/^zcode-ide\/lib\/zcode-ide-[^/]+\.jar$/i.test(entry.fileName) && !jarEntry) {
        jarEntry = entry;
      }
      if (entry.fileName.startsWith("zcode-ide/runtime/")) hasRuntime = true;
      if (entry.fileName === "zcode-ide/runtime/web/index.html") hasRuntimeIndex = true;
    });

    if (!jarEntry) {
      throw new InstallError(
        "插件包不完整：未找到 zcode-ide/lib/zcode-ide-*.jar。请重新构建插件后发布。",
      );
    }
    if (hasRuntime && !hasRuntimeIndex) {
      throw new InstallError(
        "插件包含 runtime/ 但缺少 runtime/web/index.html，完整包可能被截断。请重新构建 runtime。",
      );
    }

    const jarBuffer = await readEntryBuffer(zip, jarEntry);
    pluginInfo = await inspectPluginJar(jarBuffer, jarEntry.fileName);
    if (!pluginInfo.version) {
      throw new InstallError(
        `主 jar（${jarEntry.fileName}）的 META-INF/plugin.xml 缺少 <version>，无法判断插件版本。`,
      );
    }
    if (expectedVersion && pluginInfo.version !== expectedVersion) {
      throw new InstallError(
        `插件版本不一致：manifest=${expectedVersion}，主 jar=${pluginInfo.version}。` +
          "请检查远端 manifest 与 zip 是否配套。",
      );
    }
  } finally {
    try {
      zip.close();
    } catch {
      /* 已关闭 */
    }
  }

  return {
    zipPath,
    sha256: actualSha256,
    size: stat.size,
    pluginVersion: pluginInfo.version,
    pluginId: pluginInfo.id,
    entryCount,
    fileCount,
    totalBytes,
    jarName: jarEntry.fileName,
    hasRuntime,
  };
}

/** 读取主 jar 内的 META-INF/plugin.xml，确认插件 id 与版本。 */
export async function inspectPluginJar(jarBuffer, jarLabel = "主 jar") {
  const zip = await openZipFromBuffer(jarBuffer, jarLabel);
  let pluginXml = null;
  try {
    await iterateZip(zip, async (entry) => {
      if (entry.fileName === "META-INF/plugin.xml") {
        pluginXml = await readEntryBuffer(zip, entry);
      }
    });
  } finally {
    try {
      zip.close();
    } catch {
      /* 已关闭 */
    }
  }

  if (!pluginXml) {
    throw new InstallError(`${jarLabel} 内缺少 META-INF/plugin.xml，不是有效的 JetBrains 插件。`);
  }

  const text = pluginXml.toString("utf8");
  const idMatch = /<id>\s*([^<\s]+)\s*<\/id>/.exec(text);
  if (!idMatch || idMatch[1] !== PLUGIN_ID) {
    throw new InstallError(
      `主 jar 的插件 id 不是 ${PLUGIN_ID}（实际：${idMatch ? idMatch[1] : "未找到 <id>"}）。` +
        "这可能不是 ZCode IDE 插件包。",
    );
  }
  const versionMatch = /<version>\s*([^<\s]+)\s*<\/version>/.exec(text);
  return { id: idMatch[1], version: versionMatch ? versionMatch[1] : "" };
}
