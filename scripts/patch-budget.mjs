/**
 * 补丁预算：统计 fork 相对上游基线的改动面，防止 IDE 补丁悄悄膨胀。
 *
 * 口径：
 * - 只统计官方源码；packages/web-ide（自建包）和 pnpm-lock.yaml 不算冲突面。
 * - “修改”= M/R/D，是同步上游时的真实冲突面；“新增”= A，零冲突。
 * - 逐个修改文件检查是否含 IDE 门控：没有门控的是通用改动，rebase 时重点核对。
 *
 * 用法：
 *   node scripts/patch-budget.mjs                # 按已提交 HEAD 统计
 *   node scripts/patch-budget.mjs --worktree     # 连同未提交/未跟踪改动一起统计
 *   node scripts/patch-budget.mjs --max-modified 18
 *   node scripts/patch-budget.mjs --json
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const here = import.meta.dirname;
const pluginRoot = resolve(here, "..");
const lockPath = resolve(pluginRoot, "vendor/zcode.lock");

if (!existsSync(lockPath)) {
  console.error(`[budget] 缺少 ${lockPath}`);
  process.exit(1);
}
const lock = JSON.parse(readFileSync(lockPath, "utf8"));

function resolveForkDir() {
  const fromEnv = process.env.ZCODE_REPO?.trim();
  if (fromEnv) return resolve(fromEnv);
  const link = resolve(pluginRoot, "vendor/ZCode");
  if (existsSync(link)) return link;
  return resolve(pluginRoot, ".ci/ZCode");
}

const forkDir = resolveForkDir();
const base = lock.upstreamBase;
if (!base) {
  console.error("[budget] vendor/zcode.lock 缺少 upstreamBase");
  process.exit(1);
}

const argv = process.argv.slice(2);
const worktree = argv.includes("--worktree");
const asJson = argv.includes("--json");
const maxArg = (() => {
  const withValue = argv.find((arg) => arg.startsWith("--max-modified="));
  if (withValue) return Number(withValue.split("=")[1]);
  const index = argv.indexOf("--max-modified");
  return index >= 0 ? Number(argv[index + 1]) : undefined;
})();
const budget = maxArg ?? Number(lock.patchBudget?.maxModified ?? 20);

function git(gitArgs) {
  try {
    return execFileSync("git", ["-C", forkDir, ...gitArgs], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function fileContent(path) {
  // 分类必须跟被测版本一致：HEAD 模式读已提交内容，worktree 模式才读工作区。
  if (!worktree) return git(["show", `HEAD:${path}`]);
  try {
    return readFileSync(resolve(forkDir, path), "utf8");
  } catch {
    return git(["show", `HEAD:${path}`]);
  }
}

const diffArgs = ["diff", "--name-status", base, ...(worktree ? [] : ["HEAD"])];
const rawDiff = git(diffArgs);
const rows = rawDiff
  ? rawDiff
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        return { status: parts[0][0], path: parts[parts.length - 1] };
      })
  : [];

if (worktree) {
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  for (const path of untracked ? untracked.split("\n").filter(Boolean) : []) {
    rows.push({ status: "A", path, untracked: true });
  }
}

const isExcluded = (path) => path.startsWith("packages/web-ide/") || path === "pnpm-lock.yaml";
const excluded = rows.filter((row) => isExcluded(row.path));
const official = rows.filter((row) => !isExcluded(row.path));
const added = official.filter((row) => row.status === "A");
const modified = official.filter((row) => row.status !== "A");
// 门控不只 isIdeHost()：侧栏用 hideActions prop，➕ 链用 onToggleSidebar/ide-header-*。
// 命中任一标记都算 IDE 专用；没命中的是通用改动（rebase 时重点核对，仍需人工判断）。
const IDE_MARKERS = /isIdeHost|ideHost|hideActions|onToggleSidebar|ide-header-new-task|ide-sidebar-toggle/;
const generic = modified.filter((row) => !IDE_MARKERS.test(fileContent(row.path)));

const result = {
  fork: forkDir,
  base,
  mode: worktree ? "worktree" : "head",
  budget,
  modified: modified.length,
  added: added.length,
  excluded: excluded.length,
  overBudget: modified.length > budget,
  generic: generic.map((row) => row.path),
  files: official.map((row) => ({ status: row.status, path: row.path })),
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[budget] fork   = ${forkDir}`);
  console.log(`[budget] base   = ${base.slice(0, 12)} (${worktree ? "worktree" : "HEAD"})`);
  console.log(
    `[budget] 官方源码：修改 ${modified.length} / 预算 ${budget}，新增 ${added.length}（零冲突），排除 ${excluded.length}`,
  );
  console.log(`[budget] 通用改动（无显式 IDE 门控，rebase 时重点核对）：${generic.length}`);
  for (const row of generic) console.log(`  ${row.status}  ${row.path}`);
  if (modified.length > 0) {
    console.log("[budget] 修改清单：");
    for (const row of modified) console.log(`  ${row.status}  ${row.path}`);
  }
}

if (result.overBudget) {
  console.error(
    `[budget] 超出预算：修改 ${modified.length} > ${budget}。优先用 web-ide CSS / platform 承接，或显式上调 patchBudget 后再提交。`,
  );
  process.exit(1);
}
