/**
 * 目标发现与 --target 解析。
 *
 * 一个“目标”就是某个 IDE 的 plugins 目录；安装时会在其下创建/替换 `zcode-ide/`。
 * 目标分两类：
 * - config：JetBrains 配置目录下的 plugins（推荐，升级 IDE 不会丢；始终保留）；
 * - install：IDE 安装目录下的 plugins（次级选项，升级/重装 IDE 可能被清掉，
 *   且 Windows 下通常需要管理员权限）。
 *
 * 对 install 目标会做真实写探针：在 plugins 目录（不存在则父目录）创建并删除一个
 * 临时文件。Windows 的 fs.access(W_OK) 只反映只读属性，不足以判断 ACL 权限，
 * 因此必须实际写一次。不可写的安装目录会被跳过，并在 skipped 中返回给调用方提示。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "./errors.mjs";
import {
  inferProductFromName,
  inferProductFromPath,
  parseConfigDirName,
  TOOLBOX_KEY_MAP,
} from "./products.mjs";

/* -------------------------------------------------------------------------- */
/* --target 解析                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 解析 `--target`：支持重复传参、逗号分隔、去空、去重、规范化路径。
 * 传入的是 plugins 目录本身（不是它的父目录）。
 */
export function parseTargetArgs(raw, cwd = process.cwd()) {
  const values = [];
  const push = (value) => {
    if (typeof value === "string") values.push(...value.split(","));
    else if (Array.isArray(value)) value.forEach(push);
  };
  push(raw);

  const result = [];
  const seen = new Set();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const normalized = path.normalize(path.resolve(cwd, trimmed));
    if (path.parse(normalized).root === normalized) {
      throw new UsageError(`--target 不能指向文件系统根目录：${normalized}`);
    }
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/** 把 --target 路径包装成与发现结果同构的目标对象。 */
export function makeExplicitTarget(pluginsDir) {
  const inferred = inferProductFromPath(pluginsDir);
  const product = inferred?.product ?? null;
  const version = inferred?.version ?? "";
  return {
    id: `target:${pluginsDir}`,
    pluginsDir,
    source: "target",
    explicit: true,
    productId: product?.id ?? null,
    productName: product?.name ?? "未识别的 IDE",
    version,
    note: "",
  };
}

/** 控制台展示用：`产品名 版本 — plugins 路径（备注）`。 */
export function formatTarget(target) {
  const version = target.version ? ` ${target.version}` : "";
  const note = target.note ? `（${target.note}）` : "";
  return `${target.productName}${version} — ${target.pluginsDir}${note}`;
}

/* -------------------------------------------------------------------------- */
/* 写探针                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 判断安装目录目标是否可写：在 plugins 目录（不存在则父目录）创建并删除临时文件。
 * @param {string} pluginsDir
 * @param {{probe?: (directory: string) => boolean}} [options] 测试可注入判定函数
 */
export function probeInstallTargetWritable(pluginsDir, options = {}) {
  const probe = options.probe ?? defaultWriteProbe;
  if (fs.existsSync(pluginsDir) && !isDirectory(pluginsDir)) return false;
  const base = isDirectory(pluginsDir) ? pluginsDir : path.dirname(pluginsDir);
  if (!isDirectory(base)) return false;
  try {
    return probe(base) === true;
  } catch {
    return false;
  }
}

/** 实际写探针：创建后立即删除；无法创建或删除都判定不可写。 */
export function defaultWriteProbe(directory) {
  const file = path.join(
    directory,
    `.zcode-idea-write-test-${process.pid}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  );
  try {
    fs.writeFileSync(file, "", { flag: "wx" });
  } catch {
    return false;
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 忽略清理失败 */
    }
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* 发现                                                                        */
/* -------------------------------------------------------------------------- */

/** 只返回目标列表（兼容旧调用方）。 */
export function discoverTargets(options = {}) {
  return discoverTargetsDetailed(options).targets;
}

/**
 * 返回 `{ targets, skipped }`：
 * - targets：可用目标（config 始终保留；install 需通过写探针）；
 * - skipped：因不可写被跳过的 install 目标，供 CLI 打印一行提示。
 */
export function discoverTargetsDetailed(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const context = {
    isWritable: options.isWritable ?? ((pluginsDir) => probeInstallTargetWritable(pluginsDir)),
    skipped: [],
  };

  const targets = [];
  if (platform === "win32") discoverWindows(targets, env, home, context);
  else if (platform === "darwin") discoverMac(targets, env, home, context);
  else discoverLinux(targets, env, home, context);

  return {
    targets: dedupeAndSort(targets),
    skipped: dedupeSkipped(context.skipped),
  };
}

function discoverWindows(out, env, home, context) {
  const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = env.PROGRAMFILES || "C:\\Program Files";

  addConfigDirs(out, path.join(appData, "JetBrains"));
  addConfigDirs(out, path.join(appData, "Google"), "androidstudio");

  addInstallDirs(out, path.join(programFiles, "JetBrains"), context);
  addInstallDirs(out, path.join(localAppData, "Programs"), context);
  addToolboxDirs(out, path.join(localAppData, "JetBrains", "Toolbox", "apps"), context);

  // Android Studio 的默认安装位置不在 JetBrains 目录下
  addInstallHome(
    out,
    path.join(programFiles, "Android", "Android Studio"),
    { product: TOOLBOX_KEY_MAP.get("androidstudio"), version: "" },
    context,
  );
}

function discoverMac(out, env, home, context) {
  const appSupport = path.join(home, "Library", "Application Support");
  addConfigDirs(out, path.join(appSupport, "JetBrains"));
  addConfigDirs(out, path.join(appSupport, "Google"), "androidstudio");

  addMacApps(out, "/Applications", context);
  addMacApps(out, path.join(home, "Applications"), context);
  addMacToolboxDirs(out, path.join(appSupport, "JetBrains", "Toolbox", "apps"), context);
}

function discoverLinux(out, env, home, context) {
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  addConfigDirs(out, path.join(configHome, "JetBrains"));
  addConfigDirs(out, path.join(configHome, "Google"), "androidstudio");

  addInstallDirs(out, "/opt", context);
  addToolboxDirs(out, path.join(home, ".local", "share", "JetBrains", "Toolbox", "apps"), context);
  addSnapDirs(out, "/snap", context);
}

/* ------------------------------ 配置目录 ------------------------------ */

function addConfigDirs(out, root, namePrefix) {
  for (const entry of listDirs(root)) {
    if (namePrefix && !entry.name.toLowerCase().startsWith(namePrefix.toLowerCase())) continue;
    const parsed = parseConfigDirName(entry.name);
    if (!parsed) continue;
    out.push({
      id: `config:${entry.path}`,
      pluginsDir: path.join(entry.path, "plugins"),
      source: "config",
      explicit: false,
      productId: parsed.product.id,
      productName: parsed.product.name,
      version: parsed.version,
      note: "",
    });
  }
}

/* ------------------------------ 安装目录 ------------------------------ */

function addInstallDirs(out, root, context) {
  for (const entry of listDirs(root)) {
    const inferred = inferProductFromName(entry.name);
    if (!inferred) continue;
    if (!isDirectory(path.join(entry.path, "bin"))) continue;
    addInstallHome(out, entry.path, inferred, context);
  }
}

function addInstallHome(out, homeDir, inferred, context) {
  if (!inferred?.product) return;
  if (!isDirectory(path.join(homeDir, "bin"))) return;
  const pluginsDir = path.join(homeDir, "plugins");
  if (!isTargetWritable(pluginsDir, context)) {
    context.skipped.push({
      productId: inferred.product.id,
      productName: inferred.product.name,
      version: inferred.version || "",
      pluginsDir,
      source: "install",
    });
    return;
  }
  out.push({
    id: `install:${pluginsDir}`,
    pluginsDir,
    source: "install",
    explicit: false,
    productId: inferred.product.id,
    productName: inferred.product.name,
    version: inferred.version || "",
    note: "IDE 安装目录，升级可能被清掉",
  });
}

/** Toolbox：apps/<Product>/<channel>/<version>/，其下再分 Windows/Linux 布局与 macOS .app 布局。 */
function addToolboxDirs(out, appsRoot, context) {
  for (const productDir of listDirs(appsRoot)) {
    const product =
      TOOLBOX_KEY_MAP.get(productDir.name.toLowerCase()) ??
      inferProductFromName(productDir.name)?.product ??
      null;
    if (!product) continue;
    for (const channelDir of listDirs(productDir.path)) {
      for (const versionDir of listDirs(channelDir.path)) {
        addInstallHome(out, versionDir.path, { product, version: versionDir.name }, context);
      }
    }
  }
}

function addMacApps(out, root, context) {
  for (const entry of listDirs(root)) {
    if (!/\.app$/i.test(entry.name)) continue;
    const inferred = inferProductFromName(entry.name);
    if (!inferred) continue;
    addMacAppHome(out, entry.path, inferred, context);
  }
}

function addMacToolboxDirs(out, appsRoot, context) {
  for (const productDir of listDirs(appsRoot)) {
    const product =
      TOOLBOX_KEY_MAP.get(productDir.name.toLowerCase()) ??
      inferProductFromName(productDir.name)?.product ??
      null;
    if (!product) continue;
    for (const channelDir of listDirs(productDir.path)) {
      for (const versionDir of listDirs(channelDir.path)) {
        for (const appDir of listDirs(versionDir.path)) {
          if (!/\.app$/i.test(appDir.name)) continue;
          addMacAppHome(out, appDir.path, { product, version: versionDir.name }, context);
        }
        // 少数 Toolbox 布局直接把 .app 内容铺在版本目录下
        addMacAppHome(out, versionDir.path, { product, version: versionDir.name }, context);
      }
    }
  }
}

function addMacAppHome(out, appDir, inferred, context) {
  const contents = path.join(appDir, "Contents");
  if (!isDirectory(path.join(contents, "MacOS"))) return;
  const pluginsDir = path.join(contents, "plugins");
  if (!isTargetWritable(pluginsDir, context)) {
    context.skipped.push({
      productId: inferred.product.id,
      productName: inferred.product.name,
      version: inferred.version || "",
      pluginsDir,
      source: "install",
    });
    return;
  }
  out.push({
    id: `install:${pluginsDir}`,
    pluginsDir,
    source: "install",
    explicit: false,
    productId: inferred.product.id,
    productName: inferred.product.name,
    version: inferred.version || "",
    note: "IDE 安装目录，升级可能被清掉",
  });
}

/** Snap：/snap/<package>/current/。产品从 snap 包名推断。 */
function addSnapDirs(out, snapRoot, context) {
  for (const entry of listDirs(snapRoot)) {
    const inferred = inferProductFromName(entry.name);
    if (!inferred) continue;
    const current = path.join(entry.path, "current");
    if (!isDirectory(current)) continue;
    addInstallHome(out, current, { product: inferred.product, version: inferred.version }, context);
  }
}

/* ------------------------------ 工具函数 ------------------------------ */

function readDirents(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listDirs(dir) {
  return readDirents(dir)
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
    .filter((entry) => isDirectory(entry.path));
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isTargetWritable(pluginsDir, context) {
  try {
    return context.isWritable(pluginsDir) === true;
  } catch {
    return false;
  }
}

function compareVersionDesc(a, b) {
  const left = String(a || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (right[index] || 0) - (left[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function dedupeAndSort(targets) {
  const byPath = new Map();
  for (const target of targets) {
    const key = process.platform === "win32" ? target.pluginsDir.toLowerCase() : target.pluginsDir;
    const existing = byPath.get(key);
    // 同一路径优先保留配置目录（推荐路径）
    if (!existing || (existing.source === "install" && target.source === "config")) {
      byPath.set(key, target);
    }
  }
  return [...byPath.values()].sort((a, b) => {
    const byName = a.productName.localeCompare(b.productName, "en");
    if (byName !== 0) return byName;
    return compareVersionDesc(a.version, b.version);
  });
}

function dedupeSkipped(skipped) {
  const seen = new Set();
  const result = [];
  for (const item of skipped) {
    const key = process.platform === "win32" ? item.pluginsDir.toLowerCase() : item.pluginsDir;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
