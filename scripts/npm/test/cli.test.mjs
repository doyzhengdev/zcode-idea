import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const binPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "zcode-idea.mjs",
);
const npmVersion = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(binPath), "..", "package.json"), "utf8"),
).version;

function run(args) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
}

test("--version 输出 npm 包版本", () => {
  const result = run(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes(`zcode-idea/${npmVersion}`),
    `应输出 zcode-idea/${npmVersion}，实际：${result.stdout}`,
  );
});

test("bin 带 shebang（Windows npm shim 依赖它调用 node）", () => {
  const text = fs.readFileSync(binPath, "utf8");
  assert.ok(text.startsWith("#!/usr/bin/env node\n"), "bin 首行必须是 node shebang");
});

test("--help 输出中文帮助与新增 flags", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const expected of [
    "--check",
    "--force",
    "--source <url>",
    "--zip <path>",
    "--allow-http",
    "--dry-run",
    "--no-launch",
    "--clean-cache",
    "安装结束后清理其它版本的插件包缓存（保留本次使用的版本）",
    "安装完成后不启动 IDE（默认会启动）",
  ]) {
    assert.ok(result.stdout.includes(expected), `帮助中应包含 ${expected}`);
  }
  assert.ok(!result.stdout.includes("(default: true)"), "不应再显示误导性的 default: true");
});

test("非交互环境且没有 --all/--target：退出码 2", () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /非交互终端/);
  assert.match(result.stderr, /--target/);
});

test("非默认 HTTP 源缺少 --allow-http：退出码 2", () => {
  const result = run(["--all", "--source", "http://127.0.0.1:9/zcode-ide/plugin/stable"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /HTTP/);
  assert.match(result.stderr, /--allow-http/);
});

test("--timeout 非法：退出码 2", () => {
  const result = run(["--all", "--timeout", "0"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--timeout/);
});

test("--target 指向根目录：退出码 2", () => {
  const result = run(["--target", path.parse(process.cwd()).root, "--yes"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /根目录/);
});

test("--zip 指向不存在的文件：退出码 1", () => {
  const result = run([
    "--zip",
    path.join(process.cwd(), "definitely-missing-plugin.zip"),
    "--target",
    path.join(process.cwd(), "tmp-target", "plugins"),
    "--yes",
    "--no-launch",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--zip 指定的插件包不存在/);
});

test("--help 列出 update 用法", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("npx zcode-idea@latest update"), result.stdout);
  assert.ok(result.stdout.includes("[update]"), result.stdout);
});

test("未知子命令：退出码 2", () => {
  const result = run(["deploy", "--all"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未知命令：deploy/);
});
