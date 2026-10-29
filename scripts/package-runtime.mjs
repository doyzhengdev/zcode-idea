/**
 * 把 dist/ 打包为确定性 zip，并生成（可选 Ed25519 签名的）runtime manifest。
 *
 * 前置：先跑 `node scripts/build-runtime.mjs` 组装 dist/（本脚本不组装、不发网络请求）。
 *
 * 用法：
 *   node scripts/package-runtime.mjs --write-manifest --require-sign
 *
 * 常用参数：
 *   --write-manifest   把 manifest 同时写入 src/main/resources/runtime-manifest.json（插件内置 baseline）
 *   --require-sign     缺少 RUNTIME_SIGNING_KEY 时直接失败（CI 用）；默认缺私钥只警告并跳过签名
 *   --strict-lock      等价于 ZCODE_STRICT_LOCK=1：要求 BUILD-INFO.locked=true 且与 vendor/zcode.lock 一致
 *   --channel <c>      manifest.channel，默认 stable
 *   --prefix <p>       archivePath 前缀，默认 zcode-ide（域名不进 manifest，由运行期 base URL 决定）
 *   --node-version <v> manifest.nodeVersion；优先级高于环境变量 ZCODE_RUNTIME_NODE_VERSION，默认 24.14.0
 *   --runtime-version <v> 直接指定 runtimeVersion（如 `0.1.1+b177da31c187`），**仅用于本地/测试环境验证更新流程**，
 *                        正式发布一律省略、按下面的版本模型自动生成
 *
 * 输出（build/runtime/）：
 *   zcode-runtime-<runtimeVersion>.zip   确定性 zip：条目按路径排序、mtime 固定为 BUILD-INFO.builtAt、统一压缩级别
 *   manifest.json                        2 空格缩进 + 结尾换行，UTF-8 无 BOM
 *   manifest.sig                         对 manifest.json 原始字节的 Ed25519 签名（base64，有私钥时才生成）
 *
 * 版本模型：runtimeVersion = <pluginVersion>+<forkCommit 前 12 位>（如 0.1.0+cf345dcb7d0a）；
 * 文件系统目录名与七牛对象键目录把 `+` 换成 `-`（如 0.1.0-cf345dcb7d0a）。
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";

const here = import.meta.dirname;
const pluginRoot = resolve(here, "..");
const distDir = resolve(pluginRoot, "dist");
const buildInfoPath = resolve(distDir, "BUILD-INFO.json");
const lockPath = resolve(pluginRoot, "vendor/zcode.lock");
const gradlePropsPath = resolve(pluginRoot, "gradle.properties");
const outDir = resolve(pluginRoot, "build/runtime");
const resourcesManifestPath = resolve(pluginRoot, "src/main/resources/runtime-manifest.json");
const signingPublicKeyPath = resolve(pluginRoot, "src/main/resources/runtime-signing-public.pem");

/** dist/ 里必须存在的文件：缺一即失败，避免打出半成品 runtime。 */
const REQUIRED_FILES = [
  "server/entry-http.js",
  "web/index.html",
  "agent/zcode.cjs",
  "remote-bridge/index.mjs",
  "LICENSE",
  "NOTICE.md",
  "THIRD-PARTY-NOTICES.md",
];

function fail(message) {
  console.error(`[package] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { writeManifest: false, requireSign: false, strictLock: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--write-manifest":
        args.writeManifest = true;
        break;
      case "--require-sign":
        args.requireSign = true;
        break;
      case "--strict-lock":
        args.strictLock = true;
        break;
      case "--channel":
        args.channel = argv[(i += 1)];
        break;
      case "--prefix":
        args.prefix = argv[(i += 1)];
        break;
      case "--node-version":
        args.nodeVersion = argv[(i += 1)];
        break;
      case "--runtime-version":
        args.runtimeVersion = argv[(i += 1)];
        break;
      case "--help":
      case "-h":
        console.log("用法：node scripts/package-runtime.mjs [--write-manifest] [--require-sign] [--strict-lock] [--channel <c>] [--prefix <p>] [--node-version <v>] [--runtime-version <v>]");
        process.exit(0);
        break;
      default:
        fail(`未知参数：${arg}（--help 查看用法）`);
    }
  }
  return args;
}

/** 从 gradle.properties 读 pluginVersion（与 build-runtime.mjs 同一正则）。 */
function readPluginVersion() {
  const text = readFileSync(gradlePropsPath, "utf8");
  const value = text.match(/^\s*pluginVersion\s*=\s*(.+)$/m)?.[1]?.trim();
  if (!value) fail(`无法从 ${gradlePropsPath} 读取 pluginVersion`);
  return value;
}

async function collectFiles(dir) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        // dist/ 应该全是真实文件；符号链接会破坏确定性（同一内容多个路径 / 断链），直接报错。
        fail(`dist/ 内出现符号链接，拒绝打包：${full}`);
      } else if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        // 只收集文件条目；空目录条目对解压无意义，跳过。
        files.push({ abs: full, rel: relative(distDir, full).replaceAll("\\", "/"), size: stat.size });
      }
    }
  }
  await walk(dir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

/** 流式计算文件 sha256 与大小，不把整个 zip 读进内存。 */
function sha256OfFile(filePath) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * 把 BUILD-INFO.builtAt（UTC 时刻）转成“字段固定”的 Date。
 *
 * yazl 写 zip 的 DOS 时间用的是 Date 的**本地**字段且没有 forceLocalTime 选项，
 * 直接传 UTC 解析出的 Date 会随机器时区变化。这里用 builtAt 的 UTC 字段构造一个
 * 本地 Date，任何时区的机器写出的 DOS 时间都一致，保证跨机器确定性。
 */
function fixedMtimeFrom(builtAt) {
  const utc = new Date(builtAt);
  if (Number.isNaN(utc.getTime())) fail(`BUILD-INFO.builtAt 不是合法时间：${builtAt}`);
  return new Date(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
    utc.getUTCHours(),
    utc.getUTCMinutes(),
    utc.getUTCSeconds(),
  );
}

/**
 * 加载 Ed25519 签名私钥：接受 PEM 原文或 base64 编码的 PEM（自动判断）。
 * 只用于 crypto.sign，任何日志都不得输出 keyRaw。
 */
function loadSigningKey(raw) {
  const pem = raw.includes("-----BEGIN") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let key;
  try {
    key = createPrivateKey(pem.trim());
  } catch (error) {
    fail(`RUNTIME_SIGNING_KEY 无法解析为私钥（支持 PEM 原文或 base64 编码的 PEM）：${error.message}`);
  }
  if (key.asymmetricKeyType !== "ed25519") fail("RUNTIME_SIGNING_KEY 不是 Ed25519 私钥");
  return key;
}

const args = parseArgs(process.argv.slice(2));

// ---- 输入校验 ----
if (!existsSync(distDir)) {
  fail(`缺少 dist/：先执行 node scripts/build-runtime.mjs（期望路径 ${distDir}）`);
}
const missing = REQUIRED_FILES.filter((rel) => !existsSync(resolve(distDir, rel)));
if (missing.length > 0) fail(`dist/ 缺少必需文件：\n  - ${missing.join("\n  - ")}`);
if (!existsSync(buildInfoPath)) fail(`缺少 ${buildInfoPath}（build-runtime.mjs 的溯源产物）`);
const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));
if (typeof buildInfo.fork?.commit !== "string" || buildInfo.fork.commit.length < 12) {
  fail("BUILD-INFO.fork.commit 缺失或过短，无法生成 runtimeVersion");
}
if (typeof buildInfo.builtAt !== "string") fail("BUILD-INFO.builtAt 缺失");

const pluginVersion = readPluginVersion();
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;

// ---- 锁校验 ----
// 严格模式（ZCODE_STRICT_LOCK=1 或 --strict-lock，CI 用）：locked 必须为 true 且 fork commit 与锁一致。
// 本地开发（默认）：只在 locked !== true 时警告继续（说明 dist 是在脏 fork 上构建的）。
const strictLock = args.strictLock || process.env.ZCODE_STRICT_LOCK === "1";
if (strictLock) {
  const problems = [];
  if (!lock?.commit) problems.push(`缺少或无 commit 的 ${lockPath}`);
  if (buildInfo.locked !== true) problems.push("BUILD-INFO.locked !== true");
  if (lock?.commit && buildInfo.fork.commit !== lock.commit) {
    problems.push(`BUILD-INFO.fork.commit ${buildInfo.fork.commit.slice(0, 12)} != 锁 ${lock.commit.slice(0, 12)}`);
  }
  if (problems.length > 0) fail(`严格锁校验失败：\n  - ${problems.join("\n  - ")}`);
  console.log("[package] 严格锁校验通过");
} else if (buildInfo.locked !== true) {
  console.warn(`[package] BUILD-INFO.locked !== true（dist 来自脏 fork），本地开发允许；CI（ZCODE_STRICT_LOCK=1）会失败`);
} else if (!lock) {
  console.warn(`[package] 缺少 ${lockPath}，跳过与锁的对账（本地开发允许）`);
}

// ---- 版本模型 ----
// --runtime-version 是调试逃生口（造一个「更新」版本验证 updater/pending/rollback），
// 正式发布不传，按 pluginVersion + fork commit 自动生成。
const runtimeVersion = args.runtimeVersion
  ? String(args.runtimeVersion).trim()
  : `${pluginVersion}+${buildInfo.fork.commit.slice(0, 12)}`;
if (!/^[0-9]+\.[0-9]+\.[0-9]+\+[0-9a-f]{7,40}$/i.test(runtimeVersion)) {
  fail(`runtimeVersion 格式不合法：${runtimeVersion}（期望 <major>.<minor>.<patch>+<commit>）`);
}
const versionDir = runtimeVersion.replaceAll("+", "-");
const major = pluginVersion.split(".")[0] ?? "0";
const minor = pluginVersion.split(".")[1] ?? "0";
const channel = args.channel ?? "stable";
const prefix = args.prefix ?? "zcode-ide";
const nodeVersion = args.nodeVersion ?? process.env.ZCODE_RUNTIME_NODE_VERSION ?? "24.14.0";

console.log(`[package] dist            = ${distDir}`);
console.log(`[package] runtimeVersion  = ${runtimeVersion}`);
console.log(`[package] channel/prefix  = ${channel} / ${prefix}`);
console.log(`[package] nodeVersion     = ${nodeVersion}`);

// ---- 确定性 zip ----
await mkdir(outDir, { recursive: true });
const zipPath = resolve(outDir, `zcode-runtime-${runtimeVersion}.zip`);
const files = await collectFiles(distDir);
const uncompressedSize = files.reduce((total, file) => total + file.size, 0);
const mtime = fixedMtimeFrom(buildInfo.builtAt);

const zipfile = new ZipFile();
for (const file of files) {
  // compressionLevel 显式固定为 9（yazl 默认 6，写死避免随依赖版本漂移）；
  // mode 显式 0o644，避免依赖打包机的文件权限；mtime 用上面构造的固定时刻。
  zipfile.addFile(file.abs, file.rel, { mtime, mode: 0o644, compressionLevel: 9 });
}
zipfile.end();
await pipeline(zipfile.outputStream, createWriteStream(zipPath));

const zipSize = lstatSync(zipPath).size;
const zipSha256 = await sha256OfFile(zipPath);

// ---- manifest（字段顺序即 schema 顺序；2 空格缩进 + 结尾换行，UTF-8 无 BOM）----
const manifest = {
  schemaVersion: 1,
  channel,
  runtimeVersion,
  runtimeApiVersion: 1,
  minPluginVersion: pluginVersion,
  maxPluginVersion: `${major}.${minor}.*`,
  nodeVersion,
  archivePath: `${prefix}/runtime/${channel}/${versionDir}/zcode-runtime.zip`,
  sha256: zipSha256,
  size: zipSize,
  uncompressedSize,
  builtAt: buildInfo.builtAt,
  forkCommit: buildInfo.fork.commit,
  notes: "",
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const manifestPath = resolve(outDir, "manifest.json");
writeFileSync(manifestPath, manifestBytes);

// ---- 签名（Ed25519，对 manifest.json 原始字节）----
const signingKeyRaw = process.env.RUNTIME_SIGNING_KEY;
const sigPath = resolve(outDir, "manifest.sig");
let signed = false;
if (!signingKeyRaw) {
  if (args.requireSign) fail("缺少环境变量 RUNTIME_SIGNING_KEY（--require-sign 要求必须签名）");
  console.warn("[package] 未设置 RUNTIME_SIGNING_KEY，跳过 manifest.sig（本地开发允许）");
  // 上一次签名运行留下的 sig 已经过期：清掉，避免 publish 拿旧 sig 配新 manifest。
  if (existsSync(sigPath)) {
    rmSync(sigPath);
    console.warn("[package] 已删除过期的 manifest.sig");
  }
} else {
  const privateKey = loadSigningKey(signingKeyRaw);
  // Ed25519 的 crypto.sign 第一个参数（算法）必须为 null。
  const signature = sign(null, manifestBytes, privateKey);
  writeFileSync(sigPath, signature.toString("base64"));
  signed = true;
  console.log(`[package] 已签名 manifest（公钥：${relative(pluginRoot, signingPublicKeyPath)}）`);
}

// ---- baseline：写入插件资源 ----
if (args.writeManifest) {
  await writeFile(resourcesManifestPath, manifestBytes);
  console.log(`[package] baseline manifest 已写入 ${relative(pluginRoot, resourcesManifestPath)}`);
}

// ---- 输出清单：路径、字节数、sha256（绝不打印私钥）----
console.log("[package] build/runtime/ 产物：");
const outputs = [zipPath, manifestPath];
if (signed) outputs.push(sigPath);
for (const path of outputs) {
  const sha256 = await sha256OfFile(path);
  console.log(`  ${relative(pluginRoot, path)}  ${lstatSync(path).size} bytes  sha256=${sha256}`);
}
console.log(`[package] done: ${files.length} 个文件，解压态 ${(uncompressedSize / 1024 / 1024).toFixed(0)}M，zip ${(zipSize / 1024 / 1024).toFixed(1)}M`);
