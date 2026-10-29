/**
 * 按 vendor/zcode.lock 准备官方源码 fork。
 *
 * fork 是独立的 git 仓库，工作副本默认就放在 vendor/ZCode（真实目录，被 .gitignore 忽略）。
 *
 * 用法：
 *   node scripts/bootstrap.mjs             # 首次 clone / 校验 / 切到锁定 commit
 *   node scripts/bootstrap.mjs --check     # 只校验（CI 用），不 clone、不切换
 *   node scripts/bootstrap.mjs --update    # 把 fork 当前 HEAD 写回锁（提交代码后执行）
 *
 * 目标目录优先级：ZCODE_REPO > <plugin>/vendor/ZCode。
 * clone 地址默认取锁里的 repo，可用 ZCODE_FORK_REPO 覆盖（镜像/私有部署）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dirname;
const pluginRoot = resolve(here, "..");
const lockPath = resolve(pluginRoot, "vendor/zcode.lock");
const forkPath = resolve(pluginRoot, "vendor/ZCode");
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const updateLock = args.has("--update");

function fail(message) {
  console.error(`[bootstrap] ${message}`);
  process.exit(1);
}

function readLock() {
  if (!existsSync(lockPath)) fail(`缺少 ${lockPath}`);
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    fail(`无法解析 vendor/zcode.lock：${error.message}`);
  }
}

function git(gitArgs, cwd) {
  return execFileSync("git", ["-C", cwd, ...gitArgs], { encoding: "utf8" }).trim();
}

const lock = readLock();
const repo = process.env.ZCODE_FORK_REPO?.trim() || lock.repo;
const target = process.env.ZCODE_REPO?.trim() ? resolve(process.env.ZCODE_REPO.trim()) : forkPath;

if (!existsSync(resolve(target, ".git"))) {
  if (checkOnly) fail(`fork 不存在：${target}（--check 模式不 clone）`);
  if (existsSync(target)) fail(`${target} 已存在但不是 git 仓库；清空该目录后重跑`);
  console.log(`[bootstrap] clone ${repo} -> ${target}`);
  execFileSync("git", ["clone", "--branch", lock.branch, repo, target], { stdio: "inherit" });
}

if (updateLock) {
  const head = git(["rev-parse", "HEAD"], target);
  const dirty = git(["status", "--porcelain"], target).length > 0;
  lock.commit = head;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`[bootstrap] lock updated: ${head}`);
  if (dirty) console.warn("[bootstrap] 注意：fork 有未提交改动，锁只固定已提交的 commit");
  process.exit(0);
}

const head = git(["rev-parse", "HEAD"], target);
const dirty = git(["status", "--porcelain"], target).length > 0;

if (!checkOnly) {
  if (head !== lock.commit && !dirty) {
    console.log(`[bootstrap] checkout ${lock.commit}`);
    execFileSync("git", ["-C", target, "fetch", "origin"], { stdio: "inherit" });
    execFileSync("git", ["-C", target, "checkout", lock.commit], { stdio: "inherit" });
  } else if (head !== lock.commit) {
    console.warn(
      `[bootstrap] fork HEAD ${head.slice(0, 12)} != lock ${lock.commit.slice(0, 12)}，工作区有未提交改动，跳过 checkout`,
    );
  }
}

const finalHead = git(["rev-parse", "HEAD"], target);
const finalDirty = git(["status", "--porcelain"], target).length > 0;

if (finalHead !== lock.commit) {
  const message = `[bootstrap] fork HEAD ${finalHead.slice(0, 12)} != lock ${lock.commit.slice(0, 12)}`;
  if (checkOnly) fail(message);
  console.warn(`${message}（本地开发允许；提交后运行 --update，CI 会按锁构建）`);
} else {
  console.log(`[bootstrap] fork OK: ${finalHead.slice(0, 12)}${finalDirty ? " (dirty)" : ""}`);
}

console.log(`[bootstrap] target = ${target}`);
