import assert from "node:assert/strict";
import test from "node:test";
import { isSymlinkEntry, validateZipEntryName } from "../lib/manifest.mjs";

test("合法条目", () => {
  for (const name of [
    "zcode-ide/",
    "zcode-ide/lib/",
    "zcode-ide/lib/zcode-ide-0.1.0.jar",
    "zcode-ide/runtime/web/index.html",
    "zcode-ide/runtime/agent/node_modules/playwright-core/bin/install.sh",
  ]) {
    assert.equal(validateZipEntryName(name), null, name);
  }
});

test("拒绝 zip-slip / 绝对路径 / 非法分隔符", () => {
  assert.match(validateZipEntryName("../evil.txt"), /\.\./);
  assert.match(validateZipEntryName("zcode-ide/../../evil.txt"), /\.\./);
  assert.match(validateZipEntryName("/etc/passwd"), /绝对路径/);
  assert.match(validateZipEntryName("C:/Windows/system32/evil.dll"), /盘符/);
  assert.match(validateZipEntryName("C:\\Windows\\evil.dll"), /反斜杠/);
  assert.match(validateZipEntryName("zcode-ide\\lib\\zcode-ide.jar"), /反斜杠/);
  assert.match(validateZipEntryName("other-root/file.txt"), /zcode-ide/);
  assert.match(validateZipEntryName(""), /为空/);
  assert.match(validateZipEntryName("zcode-ide/\0evil"), /空字符/);
});

test("符号链接条目识别", () => {
  assert.equal(isSymlinkEntry({ externalFileAttributes: (0o120777 << 16) >>> 0 }), true);
  assert.equal(isSymlinkEntry({ externalFileAttributes: (0o100644 << 16) >>> 0 }), false);
  assert.equal(isSymlinkEntry({ externalFileAttributes: (0o040755 << 16) >>> 0 }), false);
  assert.equal(isSymlinkEntry({ externalFileAttributes: 0 }), false);
});
