/**
 * 测试用插件包 fixture：构造合法 jar / zip / manifest，并可签名。
 */

import { createHash, createPrivateKey, sign } from "node:crypto";
import { createZip } from "./zip.mjs";

export function pluginXml({ id = "dev.zcode.ide", version = "0.1.0" } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<idea-plugin>
  <version>${version}</version>
  <id>${id}</id>
  <name>ZCode IDE</name>
</idea-plugin>`;
}

export const PLUGIN_XML = pluginXml();

export function pluginJar(xml = PLUGIN_XML) {
  return createZip([{ name: "META-INF/plugin.xml", data: Buffer.from(xml, "utf8") }]);
}

export function buildPluginZip({ version = "0.1.0", withRuntime = true } = {}) {
  const entries = [
    { name: "zcode-ide/", mode: 0o040755 },
    { name: "zcode-ide/lib/", mode: 0o040755 },
    {
      name: `zcode-ide/lib/zcode-ide-${version}.jar`,
      data: pluginJar(pluginXml({ version })),
    },
  ];
  if (withRuntime) {
    entries.push(
      { name: "zcode-ide/runtime/", mode: 0o040755 },
      { name: "zcode-ide/runtime/web/", mode: 0o040755 },
      { name: "zcode-ide/runtime/web/index.html", data: Buffer.from("<!doctype html>") },
      { name: "zcode-ide/runtime/server/entry-http.js", data: Buffer.from("// server") },
    );
  }
  return { buffer: createZip(entries), version };
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function buildManifest({
  zipBuffer,
  version = "0.1.0",
  channel = "stable",
  archivePath,
} = {}) {
  const digest = sha256(zipBuffer);
  const sha12 = digest.slice(0, 12);
  const resolvedArchivePath =
    archivePath ?? `zcode-ide/plugin/${channel}/${version}/zcode-ide-${version}-${sha12}.zip`;
  const manifest = {
    schemaVersion: 1,
    channel,
    pluginVersion: version,
    archivePath: resolvedArchivePath,
    sha256: digest,
    size: zipBuffer.length,
    builtAt: "2026-10-26T00:00:00.000Z",
  };
  return {
    manifest,
    bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    sha256: manifest.sha256,
  };
}

/** 用 PEM 私钥对原始字节签名，返回 base64 文本（与 manifest.sig 文件内容一致）。 */
export function signBytes(bytes, privateKeyPem) {
  return sign(null, bytes, createPrivateKey(privateKeyPem)).toString("base64");
}
