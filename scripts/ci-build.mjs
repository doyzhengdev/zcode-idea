/**
 * CI / 发布用的单入口：从 vendor/zcode.lock 取 fork 版本，构建运行时并打出插件 zip。
 *
 * 用法：
 *   node scripts/ci-build.mjs                 # 完整流程（clone/install/build/runtime/plugin）
 *   node scripts/ci-build.mjs --skip-install  # 复用已有 node_modules
 *   ZCODE_REPO=E:/work/doyzheng/zcode-ide/vendor/ZCode node scripts/ci-build.mjs --skip-install  # 本地演练
 *   CI_PUBLISH_RUNTIME=1 node scripts/ci-build.mjs    # 打包后把 runtime 发布到七牛（也可用 --publish-runtime）
 *
 * 前提：Node ≥ 24、pnpm 10、JDK 21（设置 JAVA_HOME）、git。
 * 发布 runtime 还需要：RUNTIME_SIGNING_KEY（Ed25519 私钥，CI 必需）与 QINIU_*（七牛配置，发布时必需）。
 * 产物：build/distributions/zcode-ide-<version>.zip，并打印 sha256。
 * 说明：插件包必须在 Windows 上构建——runtime 会拷贝 node-pty 等原生依赖，
 * Linux 产物缺 Windows 预编译模块。
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const here = import.meta.dirname;
const pluginRoot = resolve(here, "..");
const lockPath = resolve(pluginRoot, "vendor/zcode.lock");
const skipInstall = process.argv.includes("--skip-install");

function fail(message) {
  console.error(`[ci] ${message}`);
  process.exit(1);
}

function quote(part) {
  return /\s/.test(part) ? `"${part}"` : part;
}

/** 跨平台的命令执行：Windows 下 pnpm/gradlew 是 .cmd/.bat，必须经过 shell。 */
function run(command, args, options = {}) {
  const line = [command, ...args].map(quote).join(" ");
  console.log(`[ci] ${line}`);
  const startedAt = Date.now();
  const result = spawnSync(line, {
    stdio: "inherit",
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    shell: true,
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result.status !== 0) fail(`命令失败（exit=${result.status}，耗时 ${elapsedSec}s）：${line}`);
  console.log(`[ci] → 完成（${elapsedSec}s）`);
}

function capture(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

if (!existsSync(lockPath)) fail(`缺少 ${lockPath}`);
const lock = JSON.parse(readFileSync(lockPath, "utf8"));

// CI 闸门尽量前置：缺签名私钥时在准备 fork / 构建 fork 之前就失败，不白跑数分钟构建。
// 本地开发（非 CI、无私钥）不拦，打包段会跳过并警告。
const isCi = process.env.GITHUB_ACTIONS === "true";
const publishRuntime = process.env.CI_PUBLISH_RUNTIME === "1" || process.argv.includes("--publish-runtime");
const signingKeyPresent = Boolean(process.env.RUNTIME_SIGNING_KEY?.trim());
if (isCi && !signingKeyPresent) {
  fail("CI 环境缺少 RUNTIME_SIGNING_KEY：无法签名 runtime manifest（在仓库 Secrets 配置 Ed25519 私钥，PEM 原文或 base64）");
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
const requiredNode = Number(lock.toolchain?.node ?? 24);
if (nodeMajor < requiredNode) fail(`需要 Node ≥ ${requiredNode}，当前 ${process.version}`);

if (!process.env.JAVA_HOME) {
  console.warn("[ci] JAVA_HOME 未设置，Gradle 将使用系统 Java；本项目要求 JDK 21");
}

const repoUrl = process.env.ZCODE_FORK_REPO?.trim() || lock.repo;
const workDir = process.env.ZCODE_WORK_DIR?.trim() || resolve(pluginRoot, ".ci", "ZCode");
const forkDir = process.env.ZCODE_REPO?.trim() || workDir;

// 1. 准备 fork：ZCODE_REPO 视为已就绪；否则 clone/fetch 到固定工作目录（CI 可缓存）。
if (!process.env.ZCODE_REPO?.trim()) {
  if (!existsSync(resolve(forkDir, ".git"))) {
    mkdirSync(dirname(forkDir), { recursive: true });
    run("git", ["clone", "--branch", lock.branch, repoUrl, forkDir]);
  }
  const dirty = capture("git", ["-C", forkDir, "status", "--porcelain"]);
  if (dirty) {
    fail(`${forkDir} 有未提交改动，拒绝覆盖；CI 工作目录应保持干净（本地演练请用 ZCODE_REPO）`);
  }
  run("git", ["-C", forkDir, "fetch", "origin", lock.branch]);
  run("git", ["-C", forkDir, "checkout", lock.commit]);
}

// 2. 锁校验（复用 bootstrap 的 --check，避免两套规则）
run("node", ["scripts/bootstrap.mjs", "--check"], {
  cwd: pluginRoot,
  env: { ZCODE_REPO: forkDir },
});

// 补丁面闸门：修改的官方源码文件数超过 vendor/zcode.lock 的 patchBudget 就失败。
// 新增文件（A）不算冲突面；web-ide 与 pnpm-lock 已排除。
run("node", ["scripts/patch-budget.mjs"], {
  cwd: pluginRoot,
  env: { ZCODE_REPO: forkDir },
});

// 3. 构建 fork 的三个产物：agent → server → web-ide（与 fork 自带 build:zcode 顺序一致）
if (!skipInstall) {
  run("pnpm", ["install", "--frozen-lockfile"], { cwd: forkDir });
}
run("pnpm", ["--filter", "@zcode/cli...", "build"], { cwd: forkDir });
run("pnpm", ["--filter", "@zcode/server", "build"], { cwd: forkDir });
run("pnpm", ["--filter", "@zcode/web-ide", "build"], { cwd: forkDir });
// 远控桥是独立单文件产物（esbuild），不在上面三个目标的依赖闭包里，
// 但 build-runtime 的 must() 要求它存在——漏掉这步 CI 必挂在组装 runtime。
run("pnpm", ["--filter", "@zcode/ide-remote-bridge", "build"], { cwd: forkDir });
// 桥的类型检查放在最后：tsconfig 经 @zcode/rpc 的 types 条件消费 rpc 的 dist
// 声明产物，依赖上面 cli... 构建先产出 rpc dist。
run("pnpm", ["--filter", "@zcode/ide-remote-bridge", "typecheck"], { cwd: forkDir });

// 4. 组装 runtime（严格锁）并校验 BUILD-INFO
run("node", ["scripts/build-runtime.mjs"], {
  cwd: pluginRoot,
  env: { ZCODE_REPO: forkDir, ZCODE_STRICT_LOCK: "1" },
});
const buildInfo = JSON.parse(readFileSync(resolve(pluginRoot, "dist/BUILD-INFO.json"), "utf8"));
if (!buildInfo.locked || buildInfo.fork?.commit !== lock.commit) {
  fail(
    `BUILD-INFO 与锁不一致：locked=${buildInfo.locked} commit=${buildInfo.fork?.commit} lock=${lock.commit}`,
  );
}

// 5. runtime 打包与发布（薄插件方案 §5.3：package → publish → buildPlugin，任一步失败不进 buildPlugin）
// CI 缺私钥的失败已在脚本开头前置；这里只处理"无私钥的本地开发"跳过路径。
if (!signingKeyPresent) {
  console.warn(
    "[ci] 未设置 RUNTIME_SIGNING_KEY（非 CI 环境）：跳过 runtime 打包/发布段，直接打插件包" +
      (publishRuntime ? "；CI_PUBLISH_RUNTIME/--publish-runtime 已设置但被忽略" : ""),
  );
} else {
  // 打包脚本用根 node_modules 的 yazl 做确定性 zip：CI checkout 上没有它（.gitignore /node_modules/），
  // 按 package-lock.json 干净安装（package-lock 已入库；本地重复执行只是快速重装两个 devDep）。
  run("npm", ["ci"], { cwd: pluginRoot });
  run("node", ["scripts/package-runtime.mjs", "--write-manifest", "--require-sign"], { cwd: pluginRoot });
  if (publishRuntime) {
    // 与 publish-runtime.mjs --apply 的必需变量对齐（QINIU_BUCKET/PREFIX/UPLOAD_HOST 有默认值，不算必需）。
    const missingQiniu = ["QINIU_ACCESS_KEY", "QINIU_SECRET_KEY", "QINIU_DOMAIN"].filter(
      (name) => !process.env[name]?.trim(),
    );
    if (missingQiniu.length > 0) {
      fail(
        `发布 runtime 缺少环境变量：${missingQiniu.join(", ")}（已要求发版但七牛配置不完整；补齐 Secrets 或关闭 publishRuntime）`,
      );
    }
    run("node", ["scripts/publish-runtime.mjs", "--apply"], { cwd: pluginRoot });
  } else {
    console.log("[ci] 未开启 runtime 发布：只打包不上传（设 CI_PUBLISH_RUNTIME=1 或 --publish-runtime 开启）");
  }
}

// 6. 打插件包（薄包；baseline manifest 已在 resources）
run(process.platform === "win32" ? "gradlew.bat" : "./gradlew", ["buildPlugin", "--console=plain"], {
  cwd: pluginRoot,
});

// 7. 输出产物与校验和
const distributionDir = resolve(pluginRoot, "build", "distributions");
const zip = readdirSync(distributionDir)
  .filter((name) => name.endsWith(".zip"))
  .map((name) => resolve(distributionDir, name))
  .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
if (!zip) fail(`${distributionDir} 下没有 zip`);

const sha256 = createHash("sha256").update(readFileSync(zip)).digest("hex");
const sizeMb = (statSync(zip).size / 1024 / 1024).toFixed(0);
console.log(`[ci] fork commit = ${lock.commit}`);
console.log(`[ci] artifact    = ${zip}`);
console.log(`[ci] size        = ${sizeMb}M`);
console.log(`[ci] sha256      = ${sha256}`);
