#!/usr/bin/env node
/**
 * 本地强制更新（开发用）：
 *   1) 在 scripts/npm 执行 npm pack --json，拿到本地 tarball；
 *   2) 用 npx 直接运行该 tarball 的 zcode-idea，追加 --all --yes --force；
 *   3) 用户透传参数会追加在末尾，可覆盖默认行为（例如 --target / --no-launch / --source）。
 *
 * 用法：
 *   node scripts/local-install.mjs -- --target <临时目录>/plugins --no-launch
 *   npm run plugin:local-update -- --target <临时目录>/plugins --no-launch
 *
 * 注意：
 * - 这是开发辅助脚本，不进入 npm 包（files 只含 bin/lib/README.md）；
 * - 默认 --force，会重新下载/安装，即使已是最新；
 * - 不碰真实 IDE 时请显式传 --target 指向临时目录，并加 --no-launch。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const npmDir = path.join(here, "npm");
const repoRoot = path.resolve(here, "..");
const forwardedArgs = process.argv.slice(2);

function info(message) {
  console.log(`[local-update] ${message}`);
}

function fail(message, exitCode = 1) {
  console.error(`[local-update] 错误：${message}`);
  process.exit(exitCode);
}

/**
 * 执行 npm pack --json；返回 tarball 绝对路径。
 * 输出到独立临时目录：避免 Windows 上重复执行时旧 tgz 被 npx/杀软占用导致 EBUSY，
 * 也避免把上一次的产物误当成这一次的结果。
 */
function packTarball() {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-idea-pack-"));
  info(`打包：npm pack --json --pack-destination ${packDir}（cwd=${npmDir}）`);
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", packDir], {
    cwd: npmDir,
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`无法执行 npm pack：${result.error.message}`);
  if (result.status !== 0) {
    console.error(String(result.stderr ?? "").trim());
    fail(`npm pack 失败（退出码 ${result.status}）`, result.status ?? 1);
  }

  const stdout = String(result.stdout ?? "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // npm 偶尔会在 stdout 混入提示，退化为取最后一行 .tgz
    const match = /([^\r\n]*\.tgz)\s*$/i.exec(stdout);
    if (match) return path.resolve(packDir, path.basename(match[1].trim().replace(/^"|"$/g, "")));
    fail(`无法解析 npm pack 输出：${stdout.slice(0, 300)}`);
  }

  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const filename = entry?.filename ?? entry?.path;
  if (!filename) fail("npm pack 输出缺少 filename");
  const tarball = path.resolve(packDir, path.basename(filename));
  if (!fs.existsSync(tarball)) fail(`npm pack 声称生成了 ${tarball}，但文件不存在`);
  return tarball;
}

function quoteForShell(arg) {
  if (process.platform !== "win32") return arg;
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function runNpx(tarball) {
  // 直接 `npx --yes <tarball> --all ...` 在 npm 10 下会把后续 `--all` 当成 npm 选项，
  // 导致命令静默退出；用 --package 指定本地 tarball，再用 `--` 明确分隔命令参数。
  const args = [
    "--yes",
    "--package",
    tarball,
    "--",
    "zcode-idea",
    "--all",
    "--yes",
    "--force",
    ...forwardedArgs,
  ];
  info(
    `运行：npx --yes --package ${tarball} -- zcode-idea --all --yes --force ` +
      forwardedArgs.join(" "),
  );
  let result;
  if (process.platform === "win32") {
    // shell:true + 单条命令字符串，避免 Node 直接拼接参数导致的转义问题
    const command = ["npx", ...args.map(quoteForShell)].join(" ");
    result = spawnSync(command, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: true,
      windowsHide: false,
    });
  } else {
    result = spawnSync("npx", args, { cwd: repoRoot, stdio: "inherit" });
  }
  if (result.error) fail(`无法启动 npx：${result.error.message}`);
  return result.status ?? 1;
}

const tarball = packTarball();
info(`tarball：${tarball}`);
const status = runNpx(tarball);
if (status !== 0) fail(`本地强制更新失败（退出码 ${status}）`, status);
info("本地强制更新完成。");
