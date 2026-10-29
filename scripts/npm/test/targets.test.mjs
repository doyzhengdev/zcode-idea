import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageError } from "../lib/errors.mjs";
import {
  formatTarget,
  makeExplicitTarget,
  parseTargetArgs,
  probeInstallTargetWritable,
} from "../lib/targets.mjs";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-idea-targets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("--target：逗号分隔、重复传参、去重、去尾斜杠", (t) => {
  const root = tempDir(t);
  const first = path.join(root, "first", "plugins");
  const second = path.join(root, "second", "plugins");
  const parsed = parseTargetArgs(
    [first, `${second}, ${first}${path.sep}`],
    root,
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0], path.normalize(first));
  assert.equal(parsed[1], path.normalize(second));
});

test("--target：空值与缺省", () => {
  assert.deepEqual(parseTargetArgs(undefined), []);
  assert.deepEqual(parseTargetArgs(""), []);
  assert.deepEqual(parseTargetArgs([",", "  "]), []);
});

test("--target：拒绝文件系统根目录", () => {
  const root = path.parse(process.cwd()).root;
  assert.throws(() => parseTargetArgs(root), UsageError);
});

test("显式目标：从路径推断产品与版本", (t) => {
  const root = tempDir(t);
  const pluginsDir = path.join(root, "JetBrains", "IntelliJIdea2026.2", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });

  const target = makeExplicitTarget(pluginsDir);
  assert.equal(target.productId, "ideaUltimate");
  assert.equal(target.productName, "IntelliJ IDEA Ultimate");
  assert.equal(target.version, "2026.2");
  assert.equal(target.source, "target");
  assert.equal(target.pluginsDir, pluginsDir);
  assert.match(formatTarget(target), /IntelliJ IDEA Ultimate 2026\.2/);
});

test("显式目标：无法识别产品时保持为空", (t) => {
  const root = tempDir(t);
  const pluginsDir = path.join(root, "zcode-idea-installer-test", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });

  const target = makeExplicitTarget(pluginsDir);
  assert.equal(target.productId, null);
  assert.equal(target.productName, "未识别的 IDE");
  assert.equal(target.version, "");
  assert.match(formatTarget(target), /未识别的 IDE/);
});

/* ------------------------------ 写探针 ------------------------------ */

test("写探针：可写目录返回 true 且不留临时文件", (t) => {
  const root = tempDir(t);
  const pluginsDir = path.join(root, "plugins");
  fs.mkdirSync(pluginsDir);

  assert.equal(probeInstallTargetWritable(pluginsDir), true);
  assert.deepEqual(fs.readdirSync(pluginsDir), []);
});

test("写探针：plugins 不存在时探测父目录，且不创建 plugins", (t) => {
  const root = tempDir(t);
  const home = path.join(root, "IntelliJ IDEA 2026.2");
  const pluginsDir = path.join(home, "plugins");
  fs.mkdirSync(home);

  let probedDirectory = null;
  const ok = probeInstallTargetWritable(pluginsDir, {
    probe: (directory) => {
      probedDirectory = directory;
      return true;
    },
  });

  assert.equal(ok, true);
  assert.equal(probedDirectory, home);
  assert.equal(fs.existsSync(pluginsDir), false);
});

test("写探针：plugins 已存在时优先探测 plugins 目录", (t) => {
  const root = tempDir(t);
  const pluginsDir = path.join(root, "ide", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });

  let probedDirectory = null;
  const ok = probeInstallTargetWritable(pluginsDir, {
    probe: (directory) => {
      probedDirectory = directory;
      return true;
    },
  });

  assert.equal(ok, true);
  assert.equal(probedDirectory, pluginsDir);
});

test("写探针：探测失败判定不可写", (t) => {
  const root = tempDir(t);
  const pluginsDir = path.join(root, "plugins");
  fs.mkdirSync(pluginsDir);

  assert.equal(probeInstallTargetWritable(pluginsDir, { probe: () => false }), false);
});

test("写探针：plugins 是文件时判定不可写", (t) => {
  const root = tempDir(t);
  const pluginsDir = path.join(root, "plugins");
  fs.writeFileSync(pluginsDir, "not-a-directory");

  assert.equal(probeInstallTargetWritable(pluginsDir, { probe: () => true }), false);
});
