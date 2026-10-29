import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildManifest,
  buildPluginZip,
  signBytes,
} from "./helpers/plugin-fixture.mjs";
import { loadRepoPrivateKeyPem } from "./helpers/real-signing.mjs";
import { bufferRoute, startHttpServer } from "./helpers/server.mjs";

const binPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "zcode-idea.mjs",
);
const npmPackage = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
);
const NPM_VERSION = String(npmPackage.version);

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`无法 bump 版本：${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

const privateKeyPem = loadRepoPrivateKeyPem();
const skip = privateKeyPem
  ? false
  : "缺少 ~/.zcode/keys/runtime-signing-private.pem（或 RUNTIME_SIGNING_KEY），跳过端到端测试";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-idea-cli-e2e-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(args, env = {}) {
  // 必须异步 spawn：spawnSync 会阻塞本进程事件循环，同进程里的 HTTP 测试服务器将无法响应。
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env: { ...process.env, NO_COLOR: "1", ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function serveRelease(t, { version = NPM_VERSION } = {}) {
  const plugin = buildPluginZip({ version });
  const signed = buildManifest({ zipBuffer: plugin.buffer, version });
  const signature = signBytes(signed.bytes, privateKeyPem);
  const basePath = "/zcode-ide/plugin/stable";
  const versionBase = `${basePath}/${version}`;
  const zipName = path.posix.basename(signed.manifest.archivePath);
  const zipRequestPath = `/${signed.manifest.archivePath}`;
  const server = await startHttpServer({
    routes: {
      [`${versionBase}/manifest.json`]: bufferRoute(signed.bytes, "application/json"),
      [`${versionBase}/manifest.sig`]: bufferRoute(Buffer.from(signature, "utf8")),
      [zipRequestPath]: bufferRoute(plugin.buffer),
    },
  });
  t.after(() => server.close());
  return {
    server,
    baseUrl: `${server.origin}${basePath}`,
    basePath,
    versionBase,
    version,
    zipName,
    zipRequestPath,
    zipBuffer: plugin.buffer,
    manifest: signed.manifest,
  };
}

test("端到端：下载 → 校验 → 安装 → 已是最新 → --force → --check 不下载", { skip }, async (t) => {
  const root = tempRoot(t);
  const release = await serveRelease(t);
  const target = path.join(root, "target", "plugins");
  const env = { ZCODE_DATA_BASE_DIR: path.join(root, "data") };
  const zipRequests = () =>
    release.server.requests.filter((request) => request.path === release.zipRequestPath).length;

  const baseArgs = [
    "--source",
    release.baseUrl,
    "--target",
    target,
    "--allow-http",
    "--no-launch",
  ];

  // 1) 首次安装
  const first = await runCli([...baseArgs, "--yes"], env);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /manifest 验签通过/);
  assert.match(first.stdout, /下载进度/);
  assert.match(first.stdout, /安装完成/);
  assert.ok(
    fs.existsSync(path.join(target, "zcode-ide", "lib", `zcode-ide-${NPM_VERSION}.jar`)),
  );
  assert.ok(fs.existsSync(path.join(target, "zcode-ide", "runtime", "web", "index.html")));
  assert.equal(zipRequests(), 1);
  const cachePath = path.join(
    root,
    "data",
    "ide",
    "plugin-cache",
    `${release.manifest.sha256}.zip`,
  );
  assert.ok(fs.existsSync(cachePath), "下载后应写入缓存");

  // 2) 再跑一次：已是最新，跳过
  const second = await runCli([...baseArgs, "--yes"], env);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /已是最新/);
  assert.match(second.stdout, /没有需要安装的目标/);
  assert.equal(zipRequests(), 1, "已是最新时不应重新下载");

  // 3) --force：重装，缓存命中不重复下载
  const forced = await runCli([...baseArgs, "--yes", "--force"], env);
  assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
  assert.match(forced.stdout, /强制重装/);
  assert.match(forced.stdout, /本地缓存/);
  assert.equal(zipRequests(), 1, "缓存命中时不应重新下载");

  // 4) --check：只拉 manifest/sig，不下载、不落盘
  const checkTarget = path.join(root, "check-target", "plugins");
  const requestsBefore = release.server.requests.length;
  const checked = await runCli([
    "--source",
    release.baseUrl,
    "--target",
    checkTarget,
    "--allow-http",
    "--check",
  ]);
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  assert.match(checked.stdout, /版本对比/);
  assert.match(checked.stdout, /未安装/);
  assert.match(checked.stdout, /--check 完成/);
  assert.equal(fs.existsSync(path.join(checkTarget, "zcode-ide")), false);
  const checkedRequests = release.server.requests
    .slice(requestsBefore)
    .map((request) => request.path);
  assert.deepEqual(checkedRequests, [
    `${release.versionBase}/manifest.json`,
    `${release.versionBase}/manifest.sig`,
  ]);
});

test("端到端：远端清单版本与 npm 包版本不一致时报错", { skip }, async (t) => {
  const root = tempRoot(t);
  const remoteVersion = "9.9.9";
  const plugin = buildPluginZip({ version: remoteVersion });
  const signed = buildManifest({ zipBuffer: plugin.buffer, version: remoteVersion });
  const signature = signBytes(signed.bytes, privateKeyPem);
  const basePath = "/zcode-ide/plugin/stable";
  const server = await startHttpServer({
    routes: {
      [`${basePath}/${NPM_VERSION}/manifest.json`]: bufferRoute(
        signed.bytes,
        "application/json",
      ),
      [`${basePath}/${NPM_VERSION}/manifest.sig`]: bufferRoute(
        Buffer.from(signature, "utf8"),
      ),
    },
  });
  t.after(() => server.close());

  const target = path.join(root, "mismatch-target", "plugins");
  const result = await runCli([
    "--source",
    `${server.origin}${basePath}`,
    "--target",
    target,
    "--allow-http",
    "--check",
    "--no-launch",
  ]);

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /不匹配/);
  assert.ok(output.includes(NPM_VERSION), "错误信息应包含 npm 包版本");
  assert.ok(output.includes(remoteVersion), "错误信息应包含远端清单版本");
  assert.equal(fs.existsSync(path.join(target, "zcode-ide")), false);
});

test("端到端：--zip 离线安装 + 远端降级默认拒绝、--force 强制", { skip }, async (t) => {
  const root = tempRoot(t);
  const target = path.join(root, "target", "plugins");
  const env = { ZCODE_DATA_BASE_DIR: path.join(root, "data") };

  // 用 --zip 装一个比 npm 包版本更高的版本
  const newerVersion = bumpPatch(NPM_VERSION);
  const newer = buildPluginZip({ version: newerVersion });
  const zipPath = path.join(root, `zcode-ide-${newerVersion}.zip`);
  fs.writeFileSync(zipPath, newer.buffer);
  const installedNewer = await runCli([
    "--zip",
    zipPath,
    "--target",
    target,
    "--yes",
    "--no-launch",
  ], env);
  assert.equal(installedNewer.status, 0, `${installedNewer.stdout}\n${installedNewer.stderr}`);
  assert.match(installedNewer.stdout, /本地插件包校验通过/);
  assert.ok(
    fs.existsSync(
      path.join(target, "zcode-ide", "lib", `zcode-ide-${newerVersion}.jar`),
    ),
  );

  // 远端 npm 包版本更低 → 默认跳过
  const release = await serveRelease(t);
  const baseArgs = [
    "--source",
    release.baseUrl,
    "--target",
    target,
    "--allow-http",
    "--no-launch",
    "--yes",
  ];
  const skipped = await runCli(baseArgs, env);
  assert.equal(skipped.status, 0, `${skipped.stdout}\n${skipped.stderr}`);
  const skippedOutput = `${skipped.stdout}\n${skipped.stderr}`;
  assert.match(skippedOutput, /跳过（远端版本更低）/);
  assert.match(skippedOutput, /--force 可强制降级/);
  assert.ok(
    fs.existsSync(
      path.join(target, "zcode-ide", "lib", `zcode-ide-${newerVersion}.jar`),
    ),
  );

  // --force 强制降级到 npm 包版本
  const forced = await runCli([...baseArgs, "--force"], env);
  assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
  assert.match(forced.stdout, /强制降级安装/);
  assert.ok(
    fs.existsSync(
      path.join(target, "zcode-ide", "lib", `zcode-ide-${NPM_VERSION}.jar`),
    ),
  );
  assert.equal(
    fs.existsSync(
      path.join(target, "zcode-ide", "lib", `zcode-ide-${newerVersion}.jar`),
    ),
    false,
  );
});

test("端到端：--dry-run 不下载、不写目标目录", { skip }, async (t) => {
  const root = tempRoot(t);
  const release = await serveRelease(t);
  const target = path.join(root, "dry-target", "plugins");
  const env = { ZCODE_DATA_BASE_DIR: path.join(root, "data") };

  const result = await runCli([
    "--source",
    release.baseUrl,
    "--target",
    target,
    "--allow-http",
    "--dry-run",
    "--no-launch",
  ], env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /版本对比/);
  assert.match(result.stdout, /dry-run 完成/);
  assert.equal(fs.existsSync(path.join(target, "zcode-ide")), false);
  assert.equal(
    release.server.requests.filter((request) => request.path === release.zipRequestPath).length,
    0,
    "dry-run 不应下载插件包",
  );
});

test("端到端：--clean-cache 在所有目标安装失败时跳过清理并保持退出码 1", async (t) => {
  const root = tempRoot(t);
  const plugin = buildPluginZip({ version: "0.1.0" });
  const zipPath = path.join(root, "zcode-ide-0.1.0.zip");
  fs.writeFileSync(zipPath, plugin.buffer);

  const cacheDir = path.join(root, "data", "ide", "plugin-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const oldCache = path.join(cacheDir, `${"b".repeat(64)}.zip`);
  fs.writeFileSync(oldCache, Buffer.from("old-cache"));

  // 父路径是文件 → extractPluginZip 创建目标目录失败。
  const blocker = path.join(root, "blocker");
  fs.writeFileSync(blocker, "not a directory");
  const target = path.join(blocker, "plugins");

  const result = await runCli([
    "--zip",
    zipPath,
    "--target",
    target,
    "--yes",
    "--no-launch",
    "--clean-cache",
  ], { ZCODE_DATA_BASE_DIR: path.join(root, "data") });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /安装失败，已跳过缓存清理/);
  assert.equal(fs.existsSync(oldCache), true, "安装失败时不应清理旧缓存");
});

test("端到端：缓存清理本身失败只告警，不改变安装成功的退出码", async (t) => {
  const root = tempRoot(t);
  const plugin = buildPluginZip({ version: "0.1.0" });
  const zipPath = path.join(root, "zcode-ide-0.1.0.zip");
  fs.writeFileSync(zipPath, plugin.buffer);

  // plugin-cache 是文件而非目录：readdir 抛 ENOTDIR，模拟清理失败。
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "ide"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "ide", "plugin-cache"), "not a directory");
  const target = path.join(root, "target", "plugins");

  const result = await runCli([
    "--zip",
    zipPath,
    "--target",
    target,
    "--yes",
    "--no-launch",
    "--clean-cache",
  ], { ZCODE_DATA_BASE_DIR: dataDir });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /缓存清理失败，已跳过/);
  assert.ok(fs.existsSync(path.join(target, "zcode-ide", "lib", "zcode-ide-0.1.0.jar")));
});

test("端到端：--dry-run 的清理预览失败只告警", async (t) => {
  const root = tempRoot(t);
  const plugin = buildPluginZip({ version: "0.1.0" });
  const zipPath = path.join(root, "zcode-ide-0.1.0.zip");
  fs.writeFileSync(zipPath, plugin.buffer);

  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "ide"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "ide", "plugin-cache"), "not a directory");
  const target = path.join(root, "dry-target", "plugins");

  const result = await runCli([
    "--zip",
    zipPath,
    "--target",
    target,
    "--dry-run",
    "--no-launch",
    "--clean-cache",
  ], { ZCODE_DATA_BASE_DIR: dataDir });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /缓存清理预览失败，已跳过/);
  assert.match(result.stdout, /dry-run 完成/);
  assert.equal(fs.existsSync(path.join(target, "zcode-ide")), false);
});

test("端到端：--check --clean-cache 是只读的，不删除缓存", async (t) => {
  const root = tempRoot(t);
  const plugin = buildPluginZip({ version: "0.1.0" });
  const zipPath = path.join(root, "zcode-ide-0.1.0.zip");
  fs.writeFileSync(zipPath, plugin.buffer);

  const cacheDir = path.join(root, "data", "ide", "plugin-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const oldCache = path.join(cacheDir, `${"b".repeat(64)}.zip`);
  fs.writeFileSync(oldCache, Buffer.from("old-cache"));
  const target = path.join(root, "check-target", "plugins");

  const result = await runCli([
    "--zip",
    zipPath,
    "--target",
    target,
    "--check",
    "--clean-cache",
  ], { ZCODE_DATA_BASE_DIR: path.join(root, "data") });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /--check 完成/);
  assert.equal(fs.existsSync(oldCache), true, "--check 不应删除缓存");
  assert.equal(fs.existsSync(path.join(target, "zcode-ide")), false);
});

test("端到端：update 命令等价于 --all --yes --force", { skip }, async (t) => {
  const root = tempRoot(t);
  const release = await serveRelease(t);
  const target = path.join(root, "target", "plugins");
  const env = { ZCODE_DATA_BASE_DIR: path.join(root, "data") };
  const zipRequests = () =>
    release.server.requests.filter((request) => request.path === release.zipRequestPath).length;

  const updateArgs = [
    "update",
    "--source",
    release.baseUrl,
    "--target",
    target,
    "--allow-http",
    "--no-launch",
  ];

  const first = await runCli(updateArgs, env);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.ok(
    fs.existsSync(path.join(target, "zcode-ide", "lib", `zcode-ide-${NPM_VERSION}.jar`)),
  );
  assert.equal(zipRequests(), 1);

  // 普通安装此时会判定“已是最新（跳过）”；
  const plain = await runCli(
    [
      "--source",
      release.baseUrl,
      "--target",
      target,
      "--allow-http",
      "--no-launch",
      "--yes",
    ],
    env,
  );
  assert.equal(plain.status, 0, `${plain.stdout}\n${plain.stderr}`);
  assert.match(plain.stdout, /已是最新（跳过）/);
  assert.equal(zipRequests(), 1);

  // update 隐含 --force，因此会重装；zip 命中本地缓存，不重复下载。
  const second = await runCli(updateArgs, env);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /强制重装/);
  assert.match(second.stdout, /本地缓存/);
  assert.equal(zipRequests(), 1, "缓存命中时不应重新下载");
});
