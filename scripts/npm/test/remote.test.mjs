import { generateKeyPairSync, sign } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PLUGIN_BASE_URL,
  archiveUrlFor,
  comparePluginVersions,
  fetchManifestBundle,
  manifestUrlFor,
  resolvePluginSource,
  validateArchivePath,
  validateManifestVersion,
  validatePluginManifest,
  verifyManifestSignature,
} from "../lib/remote.mjs";
import { UsageError } from "../lib/errors.mjs";
import { buildManifest, buildPluginZip } from "./helpers/plugin-fixture.mjs";
import { bufferRoute, startHttpServer } from "./helpers/server.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

const zip = buildPluginZip();
const signed = buildManifest({ zipBuffer: zip.buffer });
const signature = sign(null, signed.bytes, privateKey);
const VERSION = signed.manifest.pluginVersion;

test("验签：正确签名通过", () => {
  assert.doesNotThrow(() =>
    verifyManifestSignature(signed.bytes, Buffer.from(signature.toString("base64")), {
      publicKeyPem,
    }),
  );
});

test("验签：清单被篡改则失败", () => {
  const tampered = Buffer.from(signed.bytes.toString("utf8").replace("0.1.0", "9.9.9"));
  assert.throws(
    () =>
      verifyManifestSignature(tampered, Buffer.from(signature.toString("base64")), {
        publicKeyPem,
      }),
    /验签失败/,
  );
});

test("验签：签名长度不是 64 字节", () => {
  assert.throws(
    () => verifyManifestSignature(signed.bytes, Buffer.from("abc"), { publicKeyPem }),
    /64 字节/,
  );
});

test("archivePath：安全路径通过", () => {
  for (const value of [
    "zcode-ide-0.1.0.zip",
    "zcode-ide/plugin/stable/zcode-ide-0.1.0.zip",
    "a/b/c.zip",
  ]) {
    assert.equal(validateArchivePath(value), value);
  }
});

test("archivePath：绝对 URL / ../ 反斜杠 / 绝对路径被拒绝", () => {
  assert.throws(() => validateArchivePath("https://evil.example/x.zip"), /绝对 URL/);
  assert.throws(() => validateArchivePath("../evil.zip"), /非法路径段/);
  assert.throws(() => validateArchivePath("a/../../evil.zip"), /非法路径段/);
  assert.throws(() => validateArchivePath("a\\b.zip"), /反斜杠/);
  assert.throws(() => validateArchivePath("/etc/passwd"), /不能以 \/ 开头/);
  assert.throws(() => validateArchivePath("a//b.zip"), /非法路径段/);
  assert.throws(() => validateArchivePath("a/./b.zip"), /非法路径段/);
  assert.throws(() => validateArchivePath("a/b.zip?x=1"), /查询参数/);
  assert.throws(() => validateArchivePath("a/%2e%2e/b.zip"), /百分号编码/);
  assert.throws(() => validateArchivePath("a%2fb.zip"), /百分号编码/);
});

test("manifest：合法字段通过并规范化", () => {
  const parsed = validatePluginManifest({
    schemaVersion: 1,
    channel: "stable",
    pluginVersion: " 0.1.0 ",
    archivePath: "zcode-ide/plugin/stable/zcode-ide-0.1.0.zip",
    sha256: "A".repeat(64),
    size: 123,
    builtAt: "2026-10-26T00:00:00.000Z",
  });
  assert.equal(parsed.pluginVersion, "0.1.0");
  assert.equal(parsed.sha256, "a".repeat(64));
  assert.equal(parsed.size, 123);
});

test("manifest：非法字段被拒绝", () => {
  const base = {
    schemaVersion: 1,
    channel: "stable",
    pluginVersion: "0.1.0",
    archivePath: "zcode-ide/plugin/stable/zcode-ide-0.1.0.zip",
    sha256: "a".repeat(64),
    size: 1,
  };
  assert.throws(() => validatePluginManifest({ ...base, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => validatePluginManifest({ ...base, sha256: "xyz" }), /sha256 格式/);
  assert.throws(() => validatePluginManifest({ ...base, size: 0 }), /size 不合法/);
  assert.throws(() => validatePluginManifest({ ...base, archivePath: "../x.zip" }), /路径段/);
  assert.throws(() => validatePluginManifest(null), /不是 JSON 对象/);
});

test("版本比较：更新 / 相同 / 降级", () => {
  assert.equal(comparePluginVersions("0.1.0", "0.2.0"), -1);
  assert.equal(comparePluginVersions("0.2.0", "0.2.0"), 0);
  assert.equal(comparePluginVersions("1.0.0", "0.9.9"), 1);
  assert.equal(comparePluginVersions("0.1.0", "0.1.0-beta"), 1);
  assert.equal(comparePluginVersions("0.1.10", "0.1.9"), 1);
});

test("插件源：默认 HTTP 源无需 --allow-http", () => {
  const source = resolvePluginSource({ env: {} });
  assert.equal(source.baseUrl, DEFAULT_PLUGIN_BASE_URL);
  assert.equal(source.isDefault, true);
  assert.equal(source.isHttp, true);
});

test("插件源：HTTPS 允许，非默认 HTTP 必须显式放行", () => {
  const https = resolvePluginSource({ source: "https://cdn.example.com/zcode-ide/plugin/stable" });
  assert.equal(https.isHttp, false);
  assert.equal(https.isDefault, false);

  assert.throws(
    () => resolvePluginSource({ source: "http://127.0.0.1:8080/base", env: {} }),
    UsageError,
  );
  const allowed = resolvePluginSource({
    source: "http://127.0.0.1:8080/base",
    allowHttp: true,
  });
  assert.equal(allowed.isHttp, true);
});

test("插件源：环境变量与非法值", () => {
  const fromEnv = resolvePluginSource({
    env: { ZCODE_IDE_PLUGIN_BASE_URL: "https://env.example.com/zcode-ide/plugin/stable" },
  });
  assert.equal(fromEnv.baseUrl, "https://env.example.com/zcode-ide/plugin/stable");
  assert.throws(() => resolvePluginSource({ source: "not a url" }), UsageError);
  assert.throws(() => resolvePluginSource({ source: "ftp://example.com/x" }), UsageError);
  assert.throws(() => resolvePluginSource({ source: "https://example.com/x?y=1" }), UsageError);
});

test("下载地址：含前缀的对象键从域名根解析", () => {
  const url = archiveUrlFor(
    "http://tnbe4cmeo.hn-bkt.clouddn.com/zcode-ide/plugin/stable",
    "zcode-ide/plugin/stable/zcode-ide-0.1.0.zip",
  );
  assert.equal(
    url,
    "http://tnbe4cmeo.hn-bkt.clouddn.com/zcode-ide/plugin/stable/zcode-ide-0.1.0.zip",
  );
});

test("下载地址：只有文件名时相对 manifest 目录解析", () => {
  const url = archiveUrlFor(
    "https://cdn.example.com/zcode-ide/plugin/stable",
    "zcode-ide-0.1.0.zip",
  );
  assert.equal(url, "https://cdn.example.com/zcode-ide/plugin/stable/zcode-ide-0.1.0.zip");
});

test("下载地址：内容寻址的版本子目录仍从域名根解析", () => {
  const archivePath =
    "zcode-ide/plugin/stable/0.1.0/zcode-ide-0.1.0-b3bb4620163c.zip";
  const url = archiveUrlFor(
    "http://tnbe4cmeo.hn-bkt.clouddn.com/zcode-ide/plugin/stable",
    archivePath,
  );
  assert.equal(
    url,
    "http://tnbe4cmeo.hn-bkt.clouddn.com/zcode-ide/plugin/stable/0.1.0/" +
      "zcode-ide-0.1.0-b3bb4620163c.zip",
  );
});

test("版本化清单：地址包含版本目录，且拒绝路径字符", async () => {
  assert.equal(
    manifestUrlFor("https://cdn.example.com/zcode-ide/plugin/stable", "0.0.3"),
    "https://cdn.example.com/zcode-ide/plugin/stable/0.0.3/manifest.json",
  );
  assert.equal(validateManifestVersion("0.0.3"), "0.0.3");
  for (const bad of ["", "../evil", "1/2", `1\\2`, "v0.0.3"]) {
    assert.throws(() => validateManifestVersion(bad), UsageError);
  }
  await assert.rejects(
    fetchManifestBundle({ baseUrl: "http://127.0.0.1:9/x", version: "../evil" }),
    UsageError,
  );
});

test("fetchManifestBundle：真实 HTTP + 验签成功", async (t) => {
  const basePath = "/zcode-ide/plugin/stable";
  const versionBase = `${basePath}/${VERSION}`;
  const server = await startHttpServer({
    routes: {
      [`${versionBase}/manifest.json`]: bufferRoute(signed.bytes, "application/json"),
      [`${versionBase}/manifest.sig`]: bufferRoute(Buffer.from(signature.toString("base64"))),
      [`/${signed.manifest.archivePath}`]: bufferRoute(zip.buffer),
    },
  });
  t.after(() => server.close());

  const bundle = await fetchManifestBundle({
    baseUrl: `${server.origin}${basePath}`,
    version: VERSION,
    publicKeyPem,
  });

  assert.equal(bundle.manifest.pluginVersion, VERSION);
  assert.equal(bundle.manifest.sha256, signed.manifest.sha256);
  assert.equal(bundle.manifestUrl, `${server.origin}${versionBase}/manifest.json`);
  assert.equal(bundle.sigUrl, `${server.origin}${versionBase}/manifest.sig`);
  assert.equal(bundle.archiveUrl, `${server.origin}/${signed.manifest.archivePath}`);
  assert.deepEqual(
    server.requests.map((request) => request.path),
    [`${versionBase}/manifest.json`, `${versionBase}/manifest.sig`],
  );
});

test("fetchManifestBundle：签名不匹配则中止", async (t) => {
  const basePath = "/zcode-ide/plugin/stable";
  const versionBase = `${basePath}/${VERSION}`;
  const server = await startHttpServer({
    routes: {
      [`${versionBase}/manifest.json`]: bufferRoute(signed.bytes, "application/json"),
      // 用另一个密钥签名
      [`${versionBase}/manifest.sig`]: bufferRoute(
        Buffer.from(
          sign(
            null,
            signed.bytes,
            generateKeyPairSync("ed25519").privateKey,
          ).toString("base64"),
        ),
      ),
    },
  });
  t.after(() => server.close());

  await assert.rejects(
    fetchManifestBundle({
      baseUrl: `${server.origin}${basePath}`,
      version: VERSION,
      publicKeyPem,
    }),
    /验签失败/,
  );
});

test("fetchManifestBundle：404 立即失败（不重试）", async (t) => {
  const server = await startHttpServer({ routes: {} });
  t.after(() => server.close());

  await assert.rejects(
    fetchManifestBundle({
      baseUrl: `${server.origin}/missing`,
      version: VERSION,
      publicKeyPem,
    }),
    /HTTP 404/,
  );
  assert.equal(server.requests.length, 1);
});

test("fetchManifestBundle：5xx 重试后成功", async (t) => {
  const basePath = "/zcode-ide/plugin/stable";
  const versionBase = `${basePath}/${VERSION}`;
  let manifestAttempts = 0;
  const server = await startHttpServer({
    routes: {
      [`${versionBase}/manifest.json`]: bufferRoute(signed.bytes, "application/json"),
      [`${versionBase}/manifest.sig`]: bufferRoute(Buffer.from(signature.toString("base64"))),
    },
    onRequest(req, res, url) {
      if (url.pathname === `${versionBase}/manifest.json` && manifestAttempts < 2) {
        manifestAttempts += 1;
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("boom");
        return true;
      }
      return false;
    },
  });
  t.after(() => server.close());

  const bundle = await fetchManifestBundle({
    baseUrl: `${server.origin}${basePath}`,
    version: VERSION,
    publicKeyPem,
    retries: 3,
  });
  assert.equal(bundle.manifest.pluginVersion, VERSION);
  assert.equal(manifestAttempts, 2);
  assert.equal(
    server.requests.filter((request) => request.path.endsWith("/manifest.json")).length,
    3,
  );
});
