#!/usr/bin/env node
/**
 * 本地静态发布服务（仅手工联调/测试用）：
 *   node test/helpers/serve-plugin-release.mjs <releaseDir> [basePath]
 *
 * 把 <releaseDir> 下的文件按路径末段暴露，支持版本化清单与内容寻址 zip，例如：
 *   /zcode-ide/plugin/stable/<version>/manifest.json
 *   /zcode-ide/plugin/stable/<version>/manifest.sig
 *   /zcode-ide/plugin/stable/<version>/zcode-ide-<version>-<sha12>.zip
 *   /zcode-ide/plugin/stable/zcode-ide-0.1.0.zip
 *
 * 启动后打印：
 *   LISTENING <port>
 *   BASE http://127.0.0.1:<port>/zcode-ide/plugin/stable
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const rootArg = process.argv[2];
if (!rootArg) {
  console.error("用法：node test/helpers/serve-plugin-release.mjs <releaseDir> [basePath]");
  process.exit(1);
}
const root = path.resolve(rootArg);
const base = (process.argv[3] || "/zcode-ide/plugin/stable").replace(/\/+$/, "");

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
  if (!pathname.startsWith(`${base}/`)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const name = path.basename(pathname);
  try {
    const data = fs.readFileSync(path.join(root, name));
    res.writeHead(200, {
      "Content-Type": name.endsWith(".zip")
        ? "application/zip"
        : name.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  console.log(`LISTENING ${port}`);
  console.log(`BASE http://127.0.0.1:${port}${base}`);
});
