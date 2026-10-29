import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectPluginJar, validatePluginZip } from "../lib/manifest.mjs";
import { createZip } from "./helpers/zip.mjs";
import { PLUGIN_XML, pluginJar } from "./helpers/plugin-fixture.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function goodEntries() {
  return [
    { name: "zcode-ide/", mode: 0o040755 },
    { name: "zcode-ide/lib/", mode: 0o040755 },
    { name: "zcode-ide/lib/zcode-ide-0.1.0.jar", data: pluginJar() },
    { name: "zcode-ide/runtime/", mode: 0o040755 },
    { name: "zcode-ide/runtime/web/", mode: 0o040755 },
    { name: "zcode-ide/runtime/web/index.html", data: Buffer.from("<!doctype html>") },
  ];
}

function writeZip(t, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-idea-zip-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zipPath = path.join(root, "plugin.zip");
  fs.writeFileSync(zipPath, createZip(entries));
  return zipPath;
}

test("合法 zip：结构、插件版本、sha256", async (t) => {
  const zipPath = writeZip(t, goodEntries());
  const result = await validatePluginZip(zipPath);
  assert.equal(result.pluginVersion, "0.1.0");
  assert.equal(result.pluginId, "dev.zcode.ide");
  assert.equal(result.entryCount, 6);
  assert.equal(result.fileCount, 2);
  assert.equal(result.totalBytes, Buffer.byteLength("<!doctype html>") + pluginJar().length);
  assert.equal(result.hasRuntime, true);
  assert.equal(result.size, fs.statSync(zipPath).size);
  assert.equal(result.sha256, sha256(fs.readFileSync(zipPath)));
});

test("expectedSha256 / expectedSize / expectedVersion 对账", async (t) => {
  const zipPath = writeZip(t, goodEntries());
  const buffer = fs.readFileSync(zipPath);
  await assert.doesNotReject(
    validatePluginZip(zipPath, {
      expectedSha256: sha256(buffer),
      expectedSize: buffer.length,
      expectedVersion: "0.1.0",
    }),
  );
  await assert.rejects(
    validatePluginZip(zipPath, { expectedSha256: "f".repeat(64) }),
    /sha256 校验失败/,
  );
  await assert.rejects(validatePluginZip(zipPath, { expectedSize: 1 }), /大小校验失败/);
  await assert.rejects(
    validatePluginZip(zipPath, { expectedVersion: "9.9.9" }),
    /插件版本不一致/,
  );
});

test("缺少主 jar", async (t) => {
  const entries = goodEntries().filter((entry) => !entry.name.endsWith(".jar"));
  const zipPath = writeZip(t, entries);
  await assert.rejects(validatePluginZip(zipPath), /未找到 zcode-ide\/lib\/zcode-ide-\*\.jar/);
});

test("插件 id 不正确", async (t) => {
  const entries = goodEntries().map((entry) =>
    entry.name.endsWith(".jar")
      ? { ...entry, data: pluginJar(PLUGIN_XML.replace("dev.zcode.ide", "com.example.other")) }
      : entry,
  );
  const zipPath = writeZip(t, entries);
  await assert.rejects(validatePluginZip(zipPath), /插件 id 不是 dev\.zcode\.ide/);
});

test("jar 内缺少 plugin.xml", async (t) => {
  const entries = goodEntries().map((entry) =>
    entry.name.endsWith(".jar")
      ? { ...entry, data: createZip([{ name: "readme.txt", data: "no plugin.xml" }]) }
      : entry,
  );
  const zipPath = writeZip(t, entries);
  await assert.rejects(validatePluginZip(zipPath), /缺少 META-INF\/plugin\.xml/);
});

test("jar 内缺少 version", async (t) => {
  const entries = goodEntries().map((entry) =>
    entry.name.endsWith(".jar")
      ? { ...entry, data: pluginJar("<idea-plugin><id>dev.zcode.ide</id></idea-plugin>") }
      : entry,
  );
  const zipPath = writeZip(t, entries);
  await assert.rejects(validatePluginZip(zipPath), /缺少 <version>/);
});

test("runtime 缺少 web/index.html", async (t) => {
  const entries = goodEntries().filter(
    (entry) => entry.name !== "zcode-ide/runtime/web/index.html",
  );
  const zipPath = writeZip(t, entries);
  await assert.rejects(validatePluginZip(zipPath), /runtime\/web\/index\.html/);
});

test("拒绝 zip-slip 条目", async (t) => {
  const entries = [...goodEntries(), { name: "zcode-ide/../../evil.txt", data: "evil" }];
  const zipPath = writeZip(t, entries);
  await assert.rejects(validatePluginZip(zipPath), /不安全条目/);
});

test("拒绝符号链接条目", async (t) => {
  const entries = [
    ...goodEntries(),
    { name: "zcode-ide/link-to-etc", data: "/etc", mode: 0o120777 },
  ];
  const zipPath = writeZip(t, entries);
  await assert.rejects(validatePluginZip(zipPath), /符号链接/);
});

test("拒绝不在 zcode-ide/ 下的条目", async (t) => {
  const entries = [...goodEntries(), { name: "other/file.txt", data: "x" }];
  const zipPath = writeZip(t, entries);
  await assert.rejects(validatePluginZip(zipPath), /不在 zcode-ide\//);
});

test("拒绝重复文件条目", async (t) => {
  const entries = [
    ...goodEntries(),
    { name: "zcode-ide/lib/zcode-ide-0.1.0.jar", data: pluginJar() },
  ];
  const zipPath = writeZip(t, entries);
  await assert.rejects(validatePluginZip(zipPath), /重复文件条目/);
});

test("插件包不存在", async () => {
  await assert.rejects(
    validatePluginZip(path.join(os.tmpdir(), "zcode-idea-missing.zip")),
    /不存在或不可读/,
  );
});

test("inspectPluginJar：返回 id 与版本", async () => {
  const info = await inspectPluginJar(pluginJar(), "test.jar");
  assert.deepEqual(info, { id: "dev.zcode.ide", version: "0.1.0" });
});
