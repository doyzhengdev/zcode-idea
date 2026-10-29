import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getPluginCacheDir, prunePluginCache } from "../lib/download.mjs";

const SHA_KEEP = "a".repeat(64);
const SHA_OLD = "b".repeat(64);

function tempEnv(t) {
  // 用 ZCODE_DATA_BASE_DIR 指向临时目录，避免动到真实的 ~/.zcode。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-idea-cache-prune-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, ZCODE_DATA_BASE_DIR: root } };
}

function writeCacheFile(env, name, bytes) {
  const cacheDir = getPluginCacheDir(env);
  fs.mkdirSync(cacheDir, { recursive: true });
  const filePath = path.join(cacheDir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

test("保留 keep 中的 zip，删除其它 zip 与 .part，其它文件不动", async (t) => {
  const { env } = tempEnv(t);
  const keepPath = writeCacheFile(env, `${SHA_KEEP}.zip`, Buffer.alloc(10, 0x41));
  const oldPath = writeCacheFile(env, `${SHA_OLD}.zip`, Buffer.alloc(20, 0x42));
  // .part 即使同名 sha 在 keep 里也必须清理（下载残留）。
  const partPath = writeCacheFile(env, `${SHA_KEEP}.zip.part`, Buffer.alloc(5, 0x43));
  const unknownPath = writeCacheFile(env, "manifest.json", Buffer.alloc(3, 0x44));
  const notesPath = writeCacheFile(env, "notes.txt", Buffer.alloc(4, 0x45));
  // 非 sha256 命名的 zip 不是缓存产物，即使扩展名匹配也必须保留。
  const backupZip = writeCacheFile(env, "backup.zip", Buffer.alloc(6, 0x46));
  const namedZip = writeCacheFile(env, "zcode-ide-0.1.0.zip", Buffer.alloc(6, 0x47));
  const namedPart = writeCacheFile(env, "my-notes.zip.part", Buffer.alloc(6, 0x48));
  const subDir = path.join(getPluginCacheDir(env), "nested");
  fs.mkdirSync(subDir);
  fs.writeFileSync(path.join(subDir, "keep.txt"), "nested");

  const result = await prunePluginCache({ env, keep: [SHA_KEEP] });

  assert.equal(fs.existsSync(keepPath), true, "keep 中的 zip 应保留");
  assert.equal(fs.existsSync(oldPath), false, "其它缓存 zip 应删除");
  assert.equal(fs.existsSync(partPath), false, "缓存 .part 应删除");
  assert.equal(fs.existsSync(unknownPath), true, "未知文件不应删除");
  assert.equal(fs.existsSync(notesPath), true, "未知文件不应删除");
  assert.equal(fs.existsSync(backupZip), true, "非 sha256 命名的 zip 不应删除");
  assert.equal(fs.existsSync(namedZip), true, "非 sha256 命名的 zip 不应删除");
  assert.equal(fs.existsSync(namedPart), true, "非 sha256 命名的 .part 不应删除");
  assert.equal(fs.existsSync(path.join(subDir, "keep.txt")), true, "子目录不应删除");

  assert.equal(result.keptCount, 1);
  assert.deepEqual(
    result.removed.map((item) => item.path).sort(),
    [oldPath, partPath].sort(),
  );
  assert.equal(result.freedBytes, 25);
  assert.deepEqual(
    Object.fromEntries(result.removed.map((item) => [item.path, item.size])),
    { [oldPath]: 20, [partPath]: 5 },
  );
  assert.deepEqual(result.failed, []);
});

test("缓存目录不存在时直接返回空结果", async (t) => {
  const { env } = tempEnv(t);
  assert.equal(fs.existsSync(getPluginCacheDir(env)), false);

  const result = await prunePluginCache({ env });

  assert.deepEqual(result, { removed: [], freedBytes: 0, keptCount: 0, failed: [] });
});

test("keep 的 sha256 大小写不敏感", async (t) => {
  const { env } = tempEnv(t);
  const keepPath = writeCacheFile(env, `${SHA_KEEP}.zip`, Buffer.alloc(7, 0x41));
  const oldPath = writeCacheFile(env, `${SHA_OLD}.zip`, Buffer.alloc(9, 0x42));

  const result = await prunePluginCache({ env, keep: [SHA_KEEP.toUpperCase()] });

  assert.equal(result.keptCount, 1);
  assert.equal(fs.existsSync(keepPath), true);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(result.freedBytes, 9);
  assert.deepEqual(result.removed, [{ path: oldPath, size: 9 }]);
});

test("keep 为空时清理全部 zip", async (t) => {
  const { env } = tempEnv(t);
  const first = writeCacheFile(env, `${SHA_KEEP}.zip`, Buffer.alloc(11, 0x41));
  const second = writeCacheFile(env, `${SHA_OLD}.zip`, Buffer.alloc(13, 0x42));

  const result = await prunePluginCache({ env });

  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
  assert.equal(result.removed.length, 2);
  assert.equal(result.freedBytes, 24);
  assert.equal(result.keptCount, 0);
});

test("dryRun 只扫描不删除", async (t) => {
  const { env } = tempEnv(t);
  const oldPath = writeCacheFile(env, `${SHA_OLD}.zip`, Buffer.alloc(20, 0x42));

  const result = await prunePluginCache({ env, keep: [SHA_KEEP], dryRun: true });

  assert.deepEqual(result.removed, [{ path: oldPath, size: 20 }]);
  assert.equal(result.freedBytes, 20);
  assert.equal(fs.existsSync(oldPath), true, "dryRun 不应删除文件");
});
