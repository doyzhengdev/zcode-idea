/**
 * 测试用 HTTP 服务器：路由按 pathname 匹配，记录所有请求，可注入失败。
 */

import http from "node:http";

export function bufferRoute(buffer, contentType = "application/octet-stream") {
  return (req, res) => {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": buffer.length,
    });
    res.end(buffer);
  };
}

/**
 * @param {object} [options]
 * @param {Record<string, (req: any, res: any) => void>} [options.routes]
 * @param {(req: any, res: any, url: URL, requests: Array) => boolean} [options.onRequest]
 */
export function startHttpServer({ routes = {}, onRequest } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname });
    if (typeof onRequest === "function" && onRequest(req, res, url, requests)) return;
    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    route(req, res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const origin = `http://127.0.0.1:${address.port}`;
      resolve({
        server,
        port: address.port,
        origin,
        requests,
        close: () =>
          new Promise((done) => {
            // fetch 使用 keep-alive 连接；不主动断开会让 server.close 一直等待
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
