/**
 * 读取仓库签名私钥（仅测试/本地联调用，绝不打印内容）。
 * 优先 RUNTIME_SIGNING_KEY，其次 ~/.zcode/keys/runtime-signing-private.pem。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function loadRepoPrivateKeyPem() {
  const fromEnv = process.env.RUNTIME_SIGNING_KEY?.trim();
  if (fromEnv) {
    return fromEnv.includes("-----BEGIN")
      ? fromEnv
      : Buffer.from(fromEnv, "base64").toString("utf8");
  }
  const keyFile = path.join(os.homedir(), ".zcode", "keys", "runtime-signing-private.pem");
  if (!fs.existsSync(keyFile)) return null;
  return fs.readFileSync(keyFile, "utf8");
}
