import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensurePluginArchive,
  getCachedArchivePath,
  getPluginCacheDir,
  isCachePresent,
} from "../lib/download.mjs";
import { sha256 } from "./helpers/plugin-fixture.mjs";
import { bufferRoute, startHttpServer } from "./helpers/server.mjs";

const ARCHIVE_PATH = "/zcode-ide/plugin/stable/zcode-ide-0.1.0.zip";

function tempEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-idea-download-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, ZCODE_DATA_BASE_DIR: root } };
}

function fixture() {
  const zip = Buffer.from("fake-plugin-zip-content-".repeat(64), "utf8");
  return { zip, sha256: sha256(zip), size: zip.length };
}

test("缓存目录遵循 ZCODE_DATA_BASE_DIR", () => {
  const env = { ZCODE_DATA_BASE_DIR: path.join(os.tmpdir(), "zcode-data-root") };
  assert.equal(
    getPluginCacheDir(env),
    path.join(os.tmpdir(), "zcode-data-root", "ide", "plugin-cache"),
  );
  assert.equal(
    getCachedArchivePath("a".repeat(64), env),
    path.join(os.tmpdir(), "zcode-data-root", "ide", "plugin-cache", `${"a".repeat(64)}.zip`),
  );
});

test("下载成功、sha256 校验、二次命中缓存", async (t) => {
  const { env } = tempEnv(t);
  const local = fixture();
  const server = await startHttpServer({
    routes: { [ARCHIVE_PATH]: bufferRoute(local.zip) },
  });
  t.after(() => server.close());

  const first = await ensurePluginArchive({
    archiveUrl: `${server.origin}${ARCHIVE_PATH}`,
    sha256: local.sha256,
    size: local.size,
    env,
  });
  assert.equal(first.fromCache, false);
  assert.equal(fs.readFileSync(first.zipPath).toString("utf8"), local.zip.toString("utf8"));
  assert.equal(sha256(fs.readFileSync(first.zipPath)), local.sha256);
  assert.equal(server.requests.length, 1);

  const second = await ensurePluginArchive({
    archiveUrl: `${server.origin}${ARCHIVE_PATH}`,
    sha256: local.sha256,
    size: local.size,
    env,
  });
  assert.equal(second.fromCache, true);
  assert.equal(server.requests.length, 1, "缓存命中时不应再发请求");
  assert.equal(isCachePresent(local.sha256, local.size, env), true);
});

test("缓存 sha256 不符时删除并重新下载", async (t) => {
  const { env } = tempEnv(t);
  const local = fixture();
  const server = await startHttpServer({
    routes: { [ARCHIVE_PATH]: bufferRoute(local.zip) },
  });
  t.after(() => server.close());

  const first = await ensurePluginArchive({
    archiveUrl: `${server.origin}${ARCHIVE_PATH}`,
    sha256: local.sha256,
    size: local.size,
    env,
  });
  // 同大小、错误内容，触发 sha 校验失败分支
  fs.writeFileSync(first.zipPath, Buffer.alloc(local.size, 0x41));

  const second = await ensurePluginArchive({
    archiveUrl: `${server.origin}${ARCHIVE_PATH}`,
    sha256: local.sha256,
    size: local.size,
    env,
  });
  assert.equal(second.fromCache, false);
  assert.equal(sha256(fs.readFileSync(second.zipPath)), local.sha256);
  assert.equal(server.requests.length, 2);
});

test("下载内容 sha256 不符：重试 3 次后失败且不留正式缓存", async (t) => {
  const { env } = tempEnv(t);
  const local = fixture();
  const server = await startHttpServer({
    routes: { [ARCHIVE_PATH]: bufferRoute(local.zip) },
  });
  t.after(() => server.close());

  const wrongSha = "0".repeat(64);
  await assert.rejects(
    ensurePluginArchive({
      archiveUrl: `${server.origin}${ARCHIVE_PATH}`,
      sha256: wrongSha,
      size: local.size,
      env,
      retries: 3,
    }),
    /sha256 校验失败/,
  );
  assert.equal(server.requests.length, 3);
  assert.equal(fs.existsSync(getCachedArchivePath(wrongSha, env)), false);
  assert.equal(fs.existsSync(`${getCachedArchivePath(wrongSha, env)}.part`), false);
});

test("服务器 5xx：重试后成功", async (t) => {
  const { env } = tempEnv(t);
  const local = fixture();
  let failures = 0;
  const server = await startHttpServer({
    routes: { [ARCHIVE_PATH]: bufferRoute(local.zip) },
    onRequest(req, res, url) {
      if (url.pathname === ARCHIVE_PATH && failures < 2) {
        failures += 1;
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("boom");
        return true;
      }
      return false;
    },
  });
  t.after(() => server.close());

  const result = await ensurePluginArchive({
    archiveUrl: `${server.origin}${ARCHIVE_PATH}`,
    sha256: local.sha256,
    size: local.size,
    env,
    retries: 3,
  });
  assert.equal(result.fromCache, false);
  assert.equal(failures, 2);
  assert.equal(server.requests.length, 3);
});

test("下载大小与 manifest 不符：重试后失败", async (t) => {
  const { env } = tempEnv(t);
  const local = fixture();
  const short = local.zip.subarray(0, 10);
  const server = await startHttpServer({
    routes: { [ARCHIVE_PATH]: bufferRoute(short) },
  });
  t.after(() => server.close());

  await assert.rejects(
    ensurePluginArchive({
      archiveUrl: `${server.origin}${ARCHIVE_PATH}`,
      sha256: local.sha256,
      size: local.size,
      env,
      retries: 2,
    }),
    /下载大小不一致/,
  );
  assert.equal(server.requests.length, 2);
});
