/**
 * 组装 ZCode 运行时到 <plugin>/dist：
 *   web/     web-ide/dist
 *   server/  packages/server/dist（entry-http.js + 外置依赖入口）
 *   agent/   zcode.cjs + provider
 *   node_modules/  server 外置依赖闭包 + agent 的 playwright-core
 *   *.md     许可证与第三方声明
 *
 * 用法：
 *   node scripts/build-runtime.mjs
 *   ZCODE_REPO=E:/path/to/ZCode node scripts/build-runtime.mjs
 */
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const pluginRoot = resolve(here, "..");
const zcodeRoot = process.env.ZCODE_REPO?.trim() || resolve(pluginRoot, "vendor/ZCode");
const outRoot = process.env.ZCODE_RUNTIME_OUT?.trim() || resolve(pluginRoot, "dist");

function must(path, label) {
  if (!existsSync(path)) throw new Error(`缺少 ${label}：${path}`);
}

must(resolve(zcodeRoot, "packages/server/dist/entry-http.js"), "server dist");
must(resolve(zcodeRoot, "packages/web-ide/dist/index.html"), "web-ide dist");
must(resolve(zcodeRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs"), "agent bundle");
must(
  resolve(zcodeRoot, "packages/ide-remote-bridge/dist/index.mjs"),
  "ide-remote-bridge dist（先运行 pnpm --filter @zcode/ide-remote-bridge build）",
);

// 锁定校验：CI（CI=1 或 ZCODE_STRICT_LOCK=1）必须严格匹配 vendor/zcode.lock；
// 本地开发允许在 dirty fork 上构建，只提示。
const lockPath = resolve(pluginRoot, "vendor/zcode.lock");
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;

function gitOutput(gitArgs) {
  try {
    return execFileSync("git", ["-C", zcodeRoot, ...gitArgs], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const forkCommit = gitOutput(["rev-parse", "HEAD"]);
// CI 变量的取值因平台而异（GitHub Actions 是 "true"，别的平台可能是 "1"），
// 只有显式关闭（空 / 0 / false）才算非 CI。
const ciValue = process.env.CI;
const inCi = ciValue !== undefined && ciValue !== "" && ciValue !== "0" && ciValue !== "false";
const strictLock = inCi || process.env.ZCODE_STRICT_LOCK === "1";
if (lock?.commit && forkCommit && forkCommit !== lock.commit) {
  const message = `[runtime] fork HEAD ${forkCommit.slice(0, 12)} != lock ${lock.commit.slice(0, 12)}`;
  if (strictLock) throw new Error(message);
  console.warn(`${message}（本地开发允许；CI 会失败）`);
}
if (lock && !forkCommit) {
  console.warn(`[runtime] ${zcodeRoot} 不是 git 仓库，跳过锁校验`);
}

console.log(`[runtime] source = ${zcodeRoot}`);
console.log(`[runtime] output = ${outRoot}`);

await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });

await cp(resolve(zcodeRoot, "packages/web-ide/dist"), resolve(outRoot, "web"), {
  recursive: true,
});
await cp(resolve(zcodeRoot, "packages/server/dist"), resolve(outRoot, "server"), {
  recursive: true,
});

await mkdir(resolve(outRoot, "agent"), { recursive: true });
await cp(
  resolve(zcodeRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs"),
  resolve(outRoot, "agent/zcode.cjs"),
);
await cp(
  resolve(zcodeRoot, "apps/zcode-cli/packages/cli/dist/provider"),
  resolve(outRoot, "agent/provider"),
  { recursive: true },
);

// 插件自有的远控桥（单文件，运行时由插件自带 Node 24 执行）。
await mkdir(resolve(outRoot, "remote-bridge"), { recursive: true });
await cp(
  resolve(zcodeRoot, "packages/ide-remote-bridge/dist/index.mjs"),
  resolve(outRoot, "remote-bridge/index.mjs"),
);

// 复用官方的依赖闭包拷贝（白名单 + 传递依赖）与 node-pty prebuild 补丁。
const assetsUrl = pathToFileURL(
  resolve(zcodeRoot, "scripts/zcode-distribution/assets.mjs"),
);
const assets = await import(assetsUrl.href);
await assets.copyRuntimeNodeModules(outRoot);
await assets.patchNodePtyPrebuilds(outRoot);

// Apache-2.0 要求随分发保留许可与归属声明。
for (const [from, to] of [
  ["LICENSE", "LICENSE"],
  ["NOTICE.md", "NOTICE.md"],
  ["THIRD-PARTY-NOTICES.md", "THIRD-PARTY-NOTICES.md"],
  ["packages/server/dist/THIRD-PARTY-NOTICES.md", "server/THIRD-PARTY-NOTICES.md"],
  ["apps/zcode-cli/packages/cli/dist/THIRD-PARTY-NOTICES.md", "agent/THIRD-PARTY-NOTICES.md"],
]) {
  const source = resolve(zcodeRoot, from);
  if (existsSync(source)) await cp(source, resolve(outRoot, to));
}

// 发布包不带 sourcemap。
async function removeMaps(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) await removeMaps(full);
    else if (entry.name.endsWith(".map")) await rm(full, { force: true });
  }
}
await removeMaps(outRoot);

// 构建溯源：打包后的 runtime/BUILD-INFO.json 能回答“这次 zip 用的是哪个 fork commit”。
const pluginVersion =
  readFileSync(resolve(pluginRoot, "gradle.properties"), "utf8").match(
    /^\s*pluginVersion\s*=\s*(.+)$/m,
  )?.[1]?.trim() ?? "unknown";
const forkDirty = forkCommit ? (gitOutput(["status", "--porcelain"]) ?? "").length > 0 : null;
await writeFile(
  resolve(outRoot, "BUILD-INFO.json"),
  `${JSON.stringify(
    {
      pluginVersion,
      builtAt: new Date().toISOString(),
      fork: {
        repo: lock?.repo ?? null,
        branch: lock?.branch ?? null,
        commit: forkCommit,
        dirty: forkDirty,
      },
      toolchain: { ...(lock?.toolchain ?? {}), node: process.version },
      locked: Boolean(lock?.commit && forkCommit === lock.commit),
    },
    null,
    2,
  )}\n`,
);

async function directorySize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

const totalMb = (await directorySize(outRoot)) / 1024 / 1024;
console.log(`[runtime] done: ${totalMb.toFixed(0)}M  ${outRoot}`);
console.log(
  `[runtime] build info: ${forkCommit?.slice(0, 12) ?? "unknown"}${forkDirty ? " (dirty)" : ""}`,
);
