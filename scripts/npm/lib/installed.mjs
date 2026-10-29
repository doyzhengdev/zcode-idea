/**
 * 读取目标 plugins 目录中已安装的 ZCode 插件版本。
 *
 * 版本来源：`<pluginsDir>/zcode-ide/lib/zcode-ide-*.jar` 内的 META-INF/plugin.xml。
 * 读取失败不抛错（避免因为一个损坏的旧安装阻断整个流程），由调用方按未安装处理并提示。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { iterateZip, openZip, readEntryBuffer } from "./manifest.mjs";

/**
 * @param {string} pluginsDir
 * @returns {Promise<{installed: boolean, version: string|null, jarPath: string|null, error: string|null}>}
 */
export async function readInstalledPlugin(pluginsDir) {
  const pluginDir = path.join(pluginsDir, "zcode-ide");
  if (!fs.existsSync(pluginDir)) {
    return { installed: false, version: null, jarPath: null, error: null };
  }

  const libDir = path.join(pluginDir, "lib");
  let entries;
  try {
    entries = await fsp.readdir(libDir);
  } catch (err) {
    return {
      installed: true,
      version: null,
      jarPath: null,
      error: `无法读取 lib 目录：${err.message}`,
    };
  }

  const jarName = entries.find((name) => /^zcode-ide-.*\.jar$/i.test(name));
  if (!jarName) {
    return {
      installed: true,
      version: null,
      jarPath: null,
      error: "lib 下没有 zcode-ide-*.jar",
    };
  }

  const jarPath = path.join(libDir, jarName);
  let zip;
  try {
    zip = await openZip(jarPath);
  } catch (err) {
    return { installed: true, version: null, jarPath, error: err.message };
  }

  try {
    let pluginXml = null;
    await iterateZip(zip, async (entry) => {
      if (entry.fileName === "META-INF/plugin.xml") {
        pluginXml = await readEntryBuffer(zip, entry);
      }
    });
    if (!pluginXml) {
      return {
        installed: true,
        version: null,
        jarPath,
        error: "jar 内缺少 META-INF/plugin.xml",
      };
    }
    const text = pluginXml.toString("utf8");
    const version = /<version>\s*([^<\s]+)\s*<\/version>/.exec(text)?.[1] ?? null;
    return {
      installed: true,
      version,
      jarPath,
      error: version ? null : "plugin.xml 缺少 <version>",
    };
  } catch (err) {
    return { installed: true, version: null, jarPath, error: err.message };
  } finally {
    try {
      zip.close();
    } catch {
      /* 已关闭 */
    }
  }
}
