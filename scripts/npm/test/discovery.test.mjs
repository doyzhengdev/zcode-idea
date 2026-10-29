import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverTargets, discoverTargetsDetailed } from "../lib/targets.mjs";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-idea-discovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mkdir(...segments) {
  fs.mkdirSync(path.join(...segments), { recursive: true });
}

test("Windows：配置目录 + 安装目录 + Toolbox 排除", (t) => {
  const root = tempDir(t);
  const appData = path.join(root, "AppData", "Roaming");
  const localAppData = path.join(root, "AppData", "Local");
  const programFiles = path.join(root, "ProgramFiles");

  mkdir(appData, "JetBrains", "IntelliJIdea2026.2");
  mkdir(appData, "JetBrains", "WebStorm2025.2");
  mkdir(appData, "JetBrains", "Toolbox"); // 非 IDE，必须排除
  mkdir(appData, "JetBrains", "PermanentDeviceId");
  mkdir(appData, "Google", "AndroidStudio2025.1");

  const installHome = path.join(programFiles, "JetBrains", "RustRover 2025.2");
  mkdir(installHome, "bin");
  mkdir(installHome, "plugins");

  const targets = discoverTargets({
    platform: "win32",
    home: root,
    env: {
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      PROGRAMFILES: programFiles,
    },
  });

  const byProduct = new Map(targets.map((target) => [target.productId, target]));
  assert.deepEqual(
    [...byProduct.keys()].sort(),
    ["androidStudio", "ideaUltimate", "rustrover", "webstorm"],
  );

  assert.equal(
    byProduct.get("ideaUltimate").pluginsDir,
    path.join(appData, "JetBrains", "IntelliJIdea2026.2", "plugins"),
  );
  assert.equal(byProduct.get("ideaUltimate").source, "config");
  assert.equal(byProduct.get("ideaUltimate").version, "2026.2");
  assert.equal(byProduct.get("webstorm").version, "2025.2");
  assert.equal(byProduct.get("androidStudio").version, "2025.1");

  assert.equal(byProduct.get("rustrover").source, "install");
  assert.match(byProduct.get("rustrover").note, /升级可能被清掉/);

  // 排序：产品名升序
  assert.deepEqual(
    targets.map((target) => target.productName),
    ["Android Studio", "IntelliJ IDEA Ultimate", "RustRover", "WebStorm"],
  );
});

test("Windows：不可写的安装目录被跳过并计入 skipped，配置目录保留", (t) => {
  const root = tempDir(t);
  const appData = path.join(root, "AppData", "Roaming");
  const programFiles = path.join(root, "ProgramFiles");

  mkdir(appData, "JetBrains", "IntelliJIdea2026.2");
  const installHome = path.join(programFiles, "JetBrains", "RustRover 2025.2");
  mkdir(installHome, "bin");
  mkdir(installHome, "plugins");

  const result = discoverTargetsDetailed({
    platform: "win32",
    home: root,
    env: {
      APPDATA: appData,
      LOCALAPPDATA: path.join(root, "AppData", "Local"),
      PROGRAMFILES: programFiles,
    },
    isWritable: () => false,
  });

  assert.deepEqual(
    result.targets.map((target) => target.productId),
    ["ideaUltimate"],
  );
  assert.equal(result.targets[0].source, "config");
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].productId, "rustrover");
  assert.equal(result.skipped[0].source, "install");
  assert.match(result.skipped[0].pluginsDir, /RustRover 2025\.2/);
});

test("discoverTargets 仍返回目标数组（兼容包装）", (t) => {
  const root = tempDir(t);
  mkdir(root, "Library", "Application Support", "JetBrains", "GoLand2025.2");
  const targets = discoverTargets({ platform: "darwin", home: root, env: {} });
  assert.ok(Array.isArray(targets));
  assert.ok(targets.some((target) => target.productId === "goland"));
});

test("Toolbox：apps/<Product>/<channel>/<version> 作为安装目录目标", (t) => {
  const root = tempDir(t);
  const localAppData = path.join(root, "AppData", "Local");
  const versionHome = path.join(
    localAppData,
    "JetBrains",
    "Toolbox",
    "apps",
    "IDEA-U",
    "ch-0",
    "2026.2",
  );
  mkdir(versionHome, "bin");
  mkdir(versionHome, "plugins");

  const targets = discoverTargets({
    platform: "win32",
    home: root,
    env: {
      APPDATA: path.join(root, "AppData", "Roaming"),
      LOCALAPPDATA: localAppData,
      PROGRAMFILES: path.join(root, "ProgramFiles"),
    },
  });

  const toolboxTarget = targets.find((target) => target.productId === "ideaUltimate");
  assert.ok(toolboxTarget);
  assert.equal(toolboxTarget.pluginsDir, path.join(versionHome, "plugins"));
  assert.equal(toolboxTarget.source, "install");
  assert.equal(toolboxTarget.version, "2026.2");
});

test("Linux：配置目录发现", (t) => {
  const root = tempDir(t);
  mkdir(root, ".config", "JetBrains", "GoLand2025.2");
  mkdir(root, ".config", "Google", "AndroidStudio2025.1");

  const targets = discoverTargets({
    platform: "linux",
    home: root,
    env: { XDG_CONFIG_HOME: undefined },
  });

  const products = targets.map((target) => target.productId);
  assert.ok(products.includes("goland"));
  assert.ok(products.includes("androidStudio"));
  const goland = targets.find((target) => target.productId === "goland");
  assert.equal(
    goland.pluginsDir,
    path.join(root, ".config", "JetBrains", "GoLand2025.2", "plugins"),
  );
});

test("macOS：配置目录发现", (t) => {
  const root = tempDir(t);
  mkdir(root, "Library", "Application Support", "JetBrains", "IntelliJIdea2026.2");

  const targets = discoverTargets({ platform: "darwin", home: root, env: {} });
  const idea = targets.find((target) => target.productId === "ideaUltimate");
  assert.ok(idea);
  assert.equal(
    idea.pluginsDir,
    path.join(
      root,
      "Library",
      "Application Support",
      "JetBrains",
      "IntelliJIdea2026.2",
      "plugins",
    ),
  );
});
