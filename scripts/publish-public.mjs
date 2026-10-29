#!/usr/bin/env node
/**
 * 生成并推送公开 GitHub 仓库的单提交快照（脱敏后）。
 *
 * 为什么单独一套：
 * - 私有仓库的历史里有内部会话纪要、个人路径与内网地址，不能直接公开；
 * - 公开仓库只要"当前代码 + 一条干净提交"，所以每次从 HEAD 取树、脱敏、重建孤儿提交。
 *
 * 默认 dry-run：只打印将执行的动作。加 --apply 才真正建临时工作区并推送。
 *
 * 用法：
 *   node scripts/publish-public.mjs                      # dry-run
 *   node scripts/publish-public.mjs --apply              # 推送到默认仓库
 *   node scripts/publish-public.mjs --apply --repo git@github.com:<you>/<repo>.git
 *
 * 约定：
 * - 只推 HEAD 已提交的内容；工作区改动不会进入公开仓库；
 * - 公开仓库的 main 会被 --force 覆盖（每次都是单提交快照）；
 * - 脱敏规则集中在本文件末尾的 REDACTIONS 表，新增内部标识时补这里。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const repoArgIndex = args.indexOf("--repo");
const targetRepo =
  repoArgIndex >= 0 ? args[repoArgIndex + 1] : "git@github.com:doyzhengdev/zcode-idea.git";

const AUTHOR_NAME = "doyzhengdev";
const AUTHOR_EMAIL = "doyzhengdev@users.noreply.github.com";

/**
 * 脱敏规则：按顺序做字面替换。只写"内部 → 通用占位"。
 *
 * 敏感字面量（本机用户名、内网域名、私有 bucket）以 base64 存放：本脚本自己也会进入公开
 * 快照，如果把 `C:\Users\<真实用户名>` 这类串直接写在这里，等于把要隐藏的内容原样发布。
 */
const b64 = (value) => Buffer.from(value, "base64").toString("utf8");
const HOME = b64("QzpcVXNlcnNcWkRZ"); // C:\Users\<本机用户名>
const HOME_ESCAPED = b64("XFxVc2Vyc1xcWkRZ"); // \\Users\\<本机用户名>（源码里的转义形式）
const HOME_FWD = HOME.replace(/\\/g, "/");
const HOME_MSYS = "/" + HOME_FWD.charAt(0).toLowerCase() + HOME_FWD.slice(2);
const WORK_OLD = b64("RTpcZ2l0ZWU="); // 旧的仓库根目录
const WORK_FWD = WORK_OLD.replace(/\\/g, "/");
const WORK_MSYS = "/" + WORK_FWD.charAt(0).toLowerCase() + WORK_FWD.slice(2);
const GITHUB_OLD = b64("RTpcZ2l0aHVi"); // 更早的仓库根目录
const HOST_OLD = b64("WkRZLVBD"); // <本机主机名>
const INTERNAL_REGISTRY = b64("bXZuLmluY2EuY29tLmNu"); // 内网 npm 仓库域名
const INTERNAL_DOMAIN = b64("aW5jYS5jb20uY24="); // 内网公司域名
const INTERNAL_EMAIL = b64("emhlbmdkb25neWluZ0BpbmNhLmNvbS5jbg=="); // 内网邮箱
const NPM_USER_OLD = b64("emhlbmdkb25neWluZw=="); // 另一个 npm 账号名
const BUCKET_OLD = b64("YmFieS12aWRlbw=="); // 私有 bucket 名
const GITEE_USER = b64("ZG95emhlbmc="); // 旧的 gitee 账号

const REDACTIONS = [
  [HOME, String.raw`C:\Users\<user>`],
  // 源码/测试里的 JS 字符串转义形式（两个反斜杠）
  [HOME_ESCAPED, String.raw`\\Users\\<user>`],
  [HOME_FWD, "C:/Users/<user>"],
  [HOME_MSYS, "/c/Users/<user>"],
  [WORK_OLD, String.raw`E:\work`],
  [WORK_FWD, "E:/work"],
  [WORK_MSYS, "/e/work"],
  [GITHUB_OLD, String.raw`E:\work`],
  [HOST_OLD, "<host>"],
  [HOST_OLD.toLowerCase(), "<host>"],
  [INTERNAL_REGISTRY, "<internal-registry>"],
  [INTERNAL_REGISTRY.replace(/.com..*$/, ""), "<internal-registry>"],
  [INTERNAL_EMAIL, "<you>@example.com"],
  [INTERNAL_DOMAIN, "<internal-domain>"],
  [b64("WkRZ"), "<user>"], // 裸本机用户名
  [b64("emR5"), "<user>"], // 裸主机名前缀（小写）
  [NPM_USER_OLD, "<npm-user>"],
  ["GITEE", "WORK"],
  ["Gitee", "Work"],
  [`https://gitee.com/${GITEE_USER}/ZCode.git`, "https://github.com/zai-org/ZCode.git"],
  [`https://gitee.com/${GITEE_USER}/zcode-ide.git`, "https://github.com/doyzhengdev/zcode-idea.git"],
  [`gitee.com/${GITEE_USER}/zcode-ide`, "github.com/doyzhengdev/zcode-idea"],
  [`gitee.com/${GITEE_USER}/ZCode`, "github.com/zai-org/ZCode"],
  [`gitee.com/${GITEE_USER}`, "github.com/zai-org"],
  [BUCKET_OLD, "<your-bucket>"],
];

// 该文件里的敏感字面量已全部 base64 化，跳过脱敏以免规则被自身替换
const SKIP_REDACT = new Set(["scripts/publish-public.mjs"]);

const BINARY_RE = /\.(png|jpg|jpeg|gif|ico|jar|zip|gz|woff2?|ttf|so|dll|exe)$/i;

function git(cwd, gitArgs, options = {}) {
  return execFileSync("git", gitArgs, { cwd, encoding: "utf8", ...options }).trim();
}

function redactTree(root) {
  const files = git(root, ["ls-files"]).split(/\r?\n/).filter(Boolean);
  let changed = 0;
  for (const file of files) {
    if (BINARY_RE.test(file) || SKIP_REDACT.has(file)) continue;
    const abs = path.join(root, file);
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const before = text;
    let next = text;
    for (const [from, to] of REDACTIONS) {
      if (next.includes(from)) next = next.split(from).join(to);
    }
    if (next !== before) {
      fs.writeFileSync(abs, next);
      changed += 1;
    }
  }
  return { files: files.length, changed };
}

function ensureFiles(root) {
  const added = [];
  for (const name of ["LICENSE", "NOTICE"]) {
    const target = path.join(root, name);
    if (fs.existsSync(target)) continue;
    const source = path.join(repoRoot, name);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, target);
    added.push(name);
  }
  return added;
}

const worktree = path.join(os.tmpdir(), `zcode-public-${process.pid}`);
const branch = "public-snapshot";

console.log(`[public] repo   = ${repoRoot}`);
console.log(`[public] target = ${targetRepo}`);
console.log(`[public] worktree = ${worktree}`);
if (!apply) {
  console.log("[public] dry-run：将做 worktree add HEAD → 脱敏 → 补 LICENSE/NOTICE → 孤儿提交 → force push main");
  console.log("[public] 加 --apply 才会执行。");
  process.exit(0);
}

let exitCode = 0;
try {
  git(repoRoot, ["worktree", "add", worktree, "HEAD", "--detach"]);
  const result = redactTree(worktree);
  const added = ensureFiles(worktree);
  console.log(`[public] 文件 ${result.files} 个，脱敏 ${result.changed} 个，补充 ${added.join("、") || "无"}`);

  git(worktree, ["add", "-A"]);
  const tree = git(worktree, ["write-tree"]);
  const message = [
    "ZCode IDE 插件：内嵌官方 Web UI，运行官方 server",
    "",
    "把官方 ZCode 的 Web UI 与 server 装进 JetBrains IDE：JCEF 承载官方页面，",
    "本机 Node 跑官方 server 与 agent，插件只提供浏览器内核、能力桥与进程管理。",
    "",
    "首个公开快照，不含历史提交（历史里有内部会话纪要）。",
  ].join("\n");
  const commit = execFileSync("git", ["commit-tree", tree, "-m", message], {
    cwd: worktree,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    },
  }).trim();

  execFileSync("git", ["push", "--force", targetRepo, `${commit}:refs/heads/main`], {
    cwd: worktree,
    stdio: "inherit",
  });
  console.log(`[public] 已推送 ${commit.slice(0, 12)} → ${targetRepo} main`);
} catch (error) {
  console.error(`[public] 失败：${error.message}`);
  exitCode = 1;
} finally {
  try {
    git(repoRoot, ["worktree", "remove", worktree, "--force"]);
  } catch {
    /* worktree 可能未创建成功 */
  }
}
process.exit(exitCode);
