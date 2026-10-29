/**
 * 查找并启动 IDE 可执行文件。
 *
 * 搜索顺序按平台覆盖：JetBrains 安装目录、LOCALAPPDATA\Programs、Toolbox、
 * /Applications（macOS）、/opt 与 /snap（Linux）；优先选择路径中包含目标版本的候选。
 * 找不到只提示“请手动打开”，不算安装失败。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { info, warn } from "./log.mjs";
import { inferProductFromName, PRODUCT_BY_ID, PRODUCTS } from "./products.mjs";

/**
 * @returns {string | null} 可执行文件的绝对路径
 */
export function findLaunchCommand(target, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();

  const product =
    (target.productId ? PRODUCT_BY_ID.get(target.productId) : null) ??
    PRODUCTS.find((item) => item.name === target.productName) ??
    null;
  if (!product) return null;

  let candidates = [];
  if (platform === "win32") candidates = windowsCandidates(product, target, env, home);
  else if (platform === "darwin") candidates = macCandidates(product, target, env, home);
  else candidates = linuxCandidates(product, target, env, home);

  const existing = [...new Set(candidates)].filter((candidate) => isFile(candidate));
  if (!existing.length) return null;

  const version = target.version || "";
  existing.sort((a, b) => scoreCandidate(b, version) - scoreCandidate(a, version));
  return existing[0];
}

function windowsCandidates(product, target, env, home) {
  const programFiles = env.PROGRAMFILES || "C:\\Program Files";
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const homes = [];

  for (const dir of listDirs(path.join(programFiles, "JetBrains"))) {
    if (matchesProductName(dir.name, product)) homes.push(dir.path);
  }
  for (const dir of listDirs(path.join(localAppData, "Programs"))) {
    if (matchesProductName(dir.name, product)) homes.push(dir.path);
  }
  for (const versionDir of toolboxVersionHomes(
    path.join(localAppData, "JetBrains", "Toolbox", "apps"),
    product,
  )) {
    homes.push(versionDir);
  }
  if (product.id === "androidStudio") {
    homes.push(path.join(programFiles, "Android", "Android Studio"));
  }

  // --target 指向 IDE 安装目录下的 plugins 时，父目录就是 IDE home
  homes.push(path.dirname(target.pluginsDir));

  return homes.flatMap((homeDir) => product.winExes.map((exe) => path.join(homeDir, "bin", exe)));
}

function macCandidates(product, target, env, home) {
  const candidates = [];
  for (const root of ["/Applications", path.join(home, "Applications")]) {
    for (const app of product.macApps) {
      for (const bin of product.macBins) {
        candidates.push(path.join(root, app, "Contents", "MacOS", bin));
      }
    }
  }

  // --target 指向 *.app/Contents/plugins 时直接定位该 app
  const segments = target.pluginsDir.split(/[\\/]+/).filter(Boolean);
  const appIndex = segments.findIndex((segment) => /\.app$/i.test(segment));
  if (appIndex >= 0) {
    const prefix = segments.slice(0, appIndex + 1).join(path.sep);
    const appRoot = prefix.startsWith(path.sep) ? prefix : `${path.sep}${prefix}`;
    for (const bin of product.macBins) {
      candidates.push(path.join(appRoot, "Contents", "MacOS", bin));
    }
  }

  const appSupport = path.join(home, "Library", "Application Support");
  for (const versionDir of toolboxVersionHomes(
    path.join(appSupport, "JetBrains", "Toolbox", "apps"),
    product,
  )) {
    for (const app of product.macApps) {
      for (const bin of product.macBins) {
        candidates.push(path.join(versionDir, app, "Contents", "MacOS", bin));
      }
    }
    for (const bin of product.macBins) {
      candidates.push(path.join(versionDir, "Contents", "MacOS", bin));
    }
  }
  return candidates;
}

function linuxCandidates(product, target, env, home) {
  const homes = [];
  for (const dir of listDirs("/opt")) {
    if (matchesProductName(dir.name, product)) homes.push(dir.path);
  }
  homes.push(path.dirname(target.pluginsDir));

  for (const versionDir of toolboxVersionHomes(
    path.join(home, ".local", "share", "JetBrains", "Toolbox", "apps"),
    product,
  )) {
    homes.push(versionDir);
  }
  for (const snapDir of listDirs("/snap")) {
    if (!matchesProductName(snapDir.name, product)) continue;
    homes.push(path.join(snapDir.path, "current"));
  }

  return homes.flatMap((homeDir) =>
    product.linuxScripts.map((script) => path.join(homeDir, "bin", script)),
  );
}

function toolboxVersionHomes(appsRoot, product) {
  const result = [];
  for (const productDir of listDirs(appsRoot)) {
    const keyMatched = product.toolboxKeys.some(
      (key) => key.toLowerCase() === productDir.name.toLowerCase(),
    );
    if (!keyMatched && !matchesProductName(productDir.name, product)) continue;
    for (const channelDir of listDirs(productDir.path)) {
      for (const versionDir of listDirs(channelDir.path)) result.push(versionDir.path);
    }
  }
  return result;
}

function matchesProductName(name, product) {
  const inferred = inferProductFromName(name);
  if (inferred?.product.id === product.id) return true;
  const lower = name.toLowerCase();
  if (product.toolboxKeys.some((key) => key.toLowerCase() === lower)) return true;
  return product.macApps.some((app) => app.replace(/\.app$/i, "").toLowerCase() === lower);
}

function scoreCandidate(candidate, version) {
  if (!version) return 0;
  return candidate.toLowerCase().includes(version.toLowerCase()) ? 1 : 0;
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
      .filter((entry) => isDirectory(entry.path));
  } catch {
    return [];
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * 以 detached 方式启动 IDE，不阻塞安装器。
 * @returns {Promise<boolean>} 是否成功拉起
 */
export function launchDetached(exe) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
      child.once("error", (err) => {
        warn(`启动失败：${exe} — ${err.message}。请手动打开 IDE。`);
        finish(false);
      });
      child.once("spawn", () => {
        child.unref();
        info(`已启动：${exe}`);
        finish(true);
      });
    } catch (err) {
      warn(`启动失败：${exe} — ${err.message}。请手动打开 IDE。`);
      finish(false);
    }
  });
}
