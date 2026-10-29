#!/usr/bin/env node
/**
 * 提交前自检：源码有改动时，本次改动里必须包含一条变更记录。
 *
 * 规则来源：.agents/docs/changes/README.md 与 AGENTS.md 的红线。
 * 纯文档改动不要求记录；源码/构建输入改动必须有。
 *
 * 用法：
 *   node scripts/check-change-log.mjs            # 优先看暂存区，无暂存则看 HEAD~1..HEAD
 *   node scripts/check-change-log.mjs --staged   # 只看暂存区
 *   node scripts/check-change-log.mjs --base=HEAD~3
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const root = process.cwd();

function git(gitArgs) {
  try {
    return execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const changedFiles = (() => {
  const baseArg = args.find((arg) => arg.startsWith("--base="));
  if (baseArg) {
    return git(["diff", "--name-only", "--diff-filter=ACMRD", `${baseArg.slice(7)}..HEAD`]);
  }
  const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMRD"]);
  if (args.includes("--staged") || staged) return staged;
  return git(["diff", "--name-only", "--diff-filter=ACMRD", "HEAD~1", "HEAD"]);
})()
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

if (changedFiles.length === 0) {
  console.log("[change-log] 没有检测到改动，跳过。");
  process.exit(0);
}

// 需要记录的路径：源码、构建输入、skill 脚本
const SOURCE_PATTERNS = [
  /^src\//,
  /^scripts\//,
  /^\.agents\/skills\//,
  /^build\.gradle\.kts$/,
  /^settings\.gradle\.kts$/,
  /^gradle\.properties$/,
  /^vendor\/zcode\.lock$/,
  /^vendor\/ZCode\//,
];

const sourceFiles = changedFiles.filter((file) => SOURCE_PATTERNS.some((re) => re.test(file)));
const logFiles = changedFiles.filter(
  (file) =>
    file.startsWith(".agents/docs/changes/") &&
    file.endsWith(".md") &&
    !file.endsWith("/README.md"),
);

if (sourceFiles.length === 0) {
  console.log("[change-log] 本次只改文档/配置，无需变更记录。");
  process.exit(0);
}

if (logFiles.length > 0) {
  console.log(`[change-log] 通过：源码改动 ${sourceFiles.length} 个，记录 ${logFiles.join(", ")}`);
  process.exit(0);
}

console.error("[change-log] 失败：检测到源码改动，但没有新增/更新变更记录。");
console.error("");
console.error("源码文件：");
for (const file of sourceFiles) console.error(`  - ${file}`);
console.error("");
console.error("请在 .agents/docs/changes/ 新增一篇记录（模板见 .agents/docs/changes/README.md）：");
console.error("  .agents/docs/changes/YYYY-MM-DD-<slug>.md");
console.error("");
console.error("注意：vendor/ZCode 是独立仓库，本脚本看不到它内部的改动；fork 侧的修改请在记录里手动列出。");
process.exit(1);
