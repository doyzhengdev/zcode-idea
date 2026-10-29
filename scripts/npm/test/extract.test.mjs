import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractPluginZip } from "../lib/unzip.mjs";
import { createZip } from "./helpers/zip.mjs";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-idea-extract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const goodEntries = () => [
  { name: "zcode-ide/", mode: 0o040755 },
  { name: "zcode-ide/lib/", mode: 0o040755 },
  { name: "zcode-ide/lib/zcode-ide-0.1.0.jar", data: Buffer.from("jar-bytes") },
  { name: "zcode-ide/runtime/web/index.html", data: Buffer.from("<!doctype html>") },
  { name: "zcode-ide/runtime/bin/tool.sh", data: Buffer.from("#!/bin/sh\n"), mode: 0o100755 },
];

test("解压：去掉 zcode-ide/ 前缀、保留权限位", async (t) => {
  const root = tempDir(t);
  const zipPath = path.join(root, "good.zip");
  fs.writeFileSync(zipPath, createZip(goodEntries()));
  const pluginsDir = path.join(root, "plugins");

  const result = await extractPluginZip({ zipPath, pluginsDir, expectedEntries: 5 });

  assert.equal(result.files, 3);
  assert.equal(result.entries, 5);
  assert.ok(fs.existsSync(path.join(pluginsDir, "zcode-ide", "lib", "zcode-ide-0.1.0.jar")));
  assert.ok(fs.existsSync(path.join(pluginsDir, "zcode-ide", "runtime", "web", "index.html")));

  if (process.platform !== "win32") {
    const mode = fs.statSync(path.join(pluginsDir, "zcode-ide", "runtime", "bin", "tool.sh")).mode;
    assert.notEqual(mode & 0o111, 0, "可执行位应保留");
  }
});

test("解压：先删除旧目录（幂等重装）", async (t) => {
  const root = tempDir(t);
  const zipPath = path.join(root, "good.zip");
  fs.writeFileSync(zipPath, createZip(goodEntries()));
  const pluginsDir = path.join(root, "plugins");
  const pluginDir = path.join(pluginsDir, "zcode-ide");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "SENTINEL-OLD.txt"), "old");

  const result = await extractPluginZip({ zipPath, pluginsDir });
  assert.equal(result.files, 3);
  assert.equal(fs.existsSync(path.join(pluginDir, "SENTINEL-OLD.txt")), false);
  assert.deepEqual(fs.readdirSync(pluginsDir), ["zcode-ide"]);
});

test("解压失败：清理半成品目录", async (t) => {
  const root = tempDir(t);
  const zipPath = path.join(root, "bad.zip");
  fs.writeFileSync(
    zipPath,
    createZip([
      { name: "zcode-ide/", mode: 0o040755 },
      { name: "zcode-ide/good.txt", data: Buffer.from("ok") },
      { name: "zcode-ide/link-to-etc", data: Buffer.from("/etc"), mode: 0o120777 },
    ]),
  );
  const pluginsDir = path.join(root, "plugins");

  await assert.rejects(extractPluginZip({ zipPath, pluginsDir }), /符号链接/);
  assert.equal(fs.existsSync(path.join(pluginsDir, "zcode-ide")), false);
});
