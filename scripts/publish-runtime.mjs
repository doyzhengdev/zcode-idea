/**
 * 把 build/runtime/ 的 zip + manifest + sig 发布到七牛云。默认 dry-run（只打印上传计划），
 * 加 --apply 才真正发起上传。
 *
 * 用法：
 *   node scripts/publish-runtime.mjs             # dry-run：打印每个对象的上传计划，不发网络请求
 *   node scripts/publish-runtime.mjs --apply     # 实际上传（缺任一必需环境变量则失败）
 *   node scripts/publish-runtime.mjs --apply --allow-http   # 仅测试域名（HTTP）联调用，禁止用于生产
 *
 * 环境变量（dry-run 全部缺失也能跑；--apply 时 AK/SK/DOMAIN 必需）：
 *   QINIU_ACCESS_KEY / QINIU_SECRET_KEY   七牛密钥，绝不入库、绝不打印
 *   QINIU_BUCKET       默认 zcode-ide
 *   QINIU_DOMAIN       CDN 根（生产必须 https://；测试域名联调用 --allow-http 显式放行 http://）
 *   QINIU_PREFIX       默认 zcode-ide，与 manifest.archivePath 的前缀对账
 *   QINIU_UPLOAD_HOST  默认 https://up-z2.qiniup.com（区域发现失败时兜底）
 *
 * 上传顺序固定：zcode-runtime.zip → manifest.sig → manifest.json（manifest 最后，
 * 避免客户端拿到指向不存在 zip 的清单）。
 *
 * 安全模型：
 *   - 版本路径不可变：远端已有同 key 但 sha256 不同 → 直接失败，必须升 runtimeVersion 重新打包；
 *   - manifest 上传前用仓库内公钥验签 manifest.sig，失败即中止；
 *   - 日志只打印 key/大小/耗时，绝不打印 AK/SK/token。
 */
import { createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { relative, resolve } from "node:path";

const here = import.meta.dirname;
const pluginRoot = resolve(here, "..");
const runtimeBuildDir = resolve(pluginRoot, "build/runtime");
const publicKeyPath = resolve(pluginRoot, "src/main/resources/runtime-signing-public.pem");

function fail(message) {
  console.error(`[publish] ${message}`);
  process.exit(1);
}

// =====================================================================
// 七牛最小实现：复制自 E:\work\<your-bucket>\uploader\src\qiniu.ts
// （按方案附录 C 要求最小化复制并保留来源注释，禁止跨仓库 import）。
// 只用 Node 内置能力（crypto + fetch），不引七牛 SDK。
// =====================================================================

/**
 * 七牛用 urlsafe base64。
 *
 * **必须保留结尾的 `=` padding**：实测去掉 padding 后七牛返回
 * `401 {"error":"bad token","error_code":"BadToken"}`。只把 `+` `/` 换成 `-` `_`。
 * （来源：<your-bucket> qiniu.ts urlsafeBase64）
 */
function urlsafeBase64(input) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * 生成上传凭证。
 *
 * putPolicy 的 scope 固定到具体 key：一次凭证只能写这一个对象。
 * insertOnly=0 表示允许覆盖（manifest/sig 是可变指针，重传幂等；
 * zip 的不可变约束由上传前的 HEAD + sha256 对账保证）。
 * （来源：<your-bucket> qiniu.ts buildUploadToken）
 */
function buildUploadToken(config, key) {
  const nowSec = Math.floor(Date.now() / 1000);
  const putPolicy = JSON.stringify({
    scope: `${config.bucket}:${key}`,
    deadline: nowSec + 3600,
    insertOnly: 0,
  });
  const encodedPolicy = urlsafeBase64(putPolicy);
  const encodedSign = urlsafeBase64(createHmac("sha1", config.secretKey).update(encodedPolicy).digest());
  return `${config.accessKey}:${encodedSign}:${encodedPolicy}`;
}

/** 管理凭证：QBox <AK>:<urlsafe(HMAC-SHA1(secret, signedText))>（来源：<your-bucket> qiniu.ts qboxAuthorization） */
function qboxAuthorization(config, signedText) {
  const signature = urlsafeBase64(createHmac("sha1", config.secretKey).update(signedText).digest());
  return `QBox ${config.accessKey}:${signature}`;
}

function firstDomain(value) {
  if (!Array.isArray(value)) return null;
  const first = value.find((item) => typeof item === "string" && item.length > 0);
  return first === undefined ? null : `https://${first}`;
}

/**
 * 区域自动发现：GET https://uc.qbox.me/v4/query?ak=<AK>&bucket=<bucket>，QBox 签名鉴权。
 * 返回上传与对象管理（rs，chgm 用）域名；查询失败不抛错，返回 null 由调用方退回默认域名。
 * （来源：<your-bucket> qiniu.ts fetchRegionHosts）
 */
async function fetchRegionHosts(config) {
  const empty = { upload: null, rs: null };
  const path = `/v4/query?ak=${encodeURIComponent(config.accessKey)}&bucket=${encodeURIComponent(config.bucket)}`;
  let response;
  try {
    response = await fetch(`https://uc.qbox.me${path}`, {
      headers: { Authorization: qboxAuthorization(config, `${path}\n`) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.warn(`[publish] 区域查询失败（退回默认上传域名）：${error.message}`);
    return empty;
  }
  if (!response.ok) {
    console.warn(`[publish] 区域查询失败 HTTP ${response.status}（退回默认上传域名）`);
    return empty;
  }
  const parsed = await response.json();
  const host = parsed.hosts?.[0];
  return {
    upload: firstDomain(host?.up?.domains),
    rs: firstDomain(host?.rs?.domains),
  };
}

/** 从上传域名反推 rs 域名：up-z2.qiniup.com → rs-z2.qbox.me（来源：<your-bucket> qiniu.ts deriveHostsFromUploadHost） */
function deriveRsHost(uploadHost) {
  const region = /(?:up|upload)-([a-z0-9]+)\.qiniup\.com/i.exec(uploadHost)?.[1];
  return region === undefined ? "https://rs.qbox.me" : `https://rs-${region}.qbox.me`;
}

/** 从错误响应里提取七牛建议的上传域名（来源：<your-bucket> qiniu.ts regionHostFromError） */
function regionHostFromError(body) {
  return /use ((?:up|upload)-[a-z0-9]+\.qiniup\.com)/i.exec(body)?.[1] ?? null;
}

/** 顺序产出 head → 文件分块 → tail，整个请求体始终只有一块在内存里（来源：<your-bucket> qiniu.ts multipartChunks） */
async function* multipartChunks(head, filePath, tail) {
  yield head;
  const stream = createReadStream(filePath, { highWaterMark: 256 * 1024 });
  for await (const chunk of stream) {
    yield chunk;
  }
  yield tail;
}

/**
 * 流式 multipart 表单上传（来源：<your-bucket> qiniu.ts uploadFile）。
 *
 * 关键点：文件不读进内存；必须带 Content-Length（chunked 会被七牛拒绝）；
 * Node fetch 用流式 body 时需要 `duplex: 'half'`。
 */
async function uploadMultipart(config, { key, filePath, size, contentType, cacheControl }, uploadHost) {
  const token = buildUploadToken(config, key);
  const boundary = `----zcodeide${randomBytes(8).toString("hex")}${Date.now().toString(16)}`;
  const filename = key.split("/").pop() ?? "file";
  // Cache-Control 作为表单字段写入对象元数据（七牛表单上传支持）；manifest/sig 必须 no-cache，
  // 否则 CDN 默认按一年缓存，客户端长期看不到新版本（实测踩坑：X-Cache: HIT + max-age=31536000）。
  const cacheControlPart = cacheControl
    ? `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="Cache-Control"\r\n\r\n' +
      `${cacheControl}\r\n`
    : "";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="token"\r\n\r\n' +
      `${token}\r\n` +
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="key"\r\n\r\n' +
      `${key}\r\n` +
      cacheControlPart +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const contentLength = head.length + size + tail.length;

  // 每次尝试都要重建流：上一次的 Readable 已被消费
  const body = Readable.from(multipartChunks(head, filePath, tail));
  const response = await fetch(`${uploadHost.replace(/\/+$/, "")}/`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(contentLength),
    },
    body,
    duplex: "half",
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const text = await response.text();
  body.destroy();
  return { ok: response.ok, status: response.status, text };
}

/** 上传一个对象：incorrect region 时按七牛提示切换上传域名重试一次。 */
async function uploadObject(config, object, uploadHostState) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const startedAt = Date.now();
    const result = await uploadMultipart(config, object, uploadHostState.host);
    if (result.ok) return Date.now() - startedAt;

    const suggested = regionHostFromError(result.text);
    if (suggested !== null && !uploadHostState.regionFixed) {
      uploadHostState.regionFixed = true;
      uploadHostState.host = `https://${suggested}`;
      console.log(`[publish] 区域不匹配，按七牛提示切换上传域名 → ${uploadHostState.host}，重试`);
      continue;
    }
    if (result.status === 413 || /RequestEntityTooLarge/i.test(result.text)) {
      fail(`HTTP 413 RequestEntityTooLarge：表单上传体积受限，请改用七牛分片上传或 qshell rput（v1 不实现分片）\n响应：${result.text.slice(0, 200)}`);
    }
    fail(`上传失败 HTTP ${result.status}：${result.text.slice(0, 200)}`);
  }
  fail("上传失败：重试后仍返回 incorrect region");
}

/** 修正对象 Content-Type（来源：<your-bucket> qiniu.ts setMime）。返回是否成功。 */
async function changeMime(config, key, mime, rsHost) {
  const path = `/chgm/${urlsafeBase64(`${config.bucket}:${key}`)}/mime/${urlsafeBase64(mime)}`;
  try {
    const response = await fetch(`${rsHost}${path}`, {
      method: "POST",
      headers: {
        Authorization: qboxAuthorization(config, `${path}\n`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 刷新 CDN 缓存（七牛刷新接口，路径式）：POST https://fusion.qiniuapi.com/refresh/<urlsafe(url)>。
 * 只刷新可变指针（manifest/sig）；zip 是版本路径 + immutable，无需刷新。
 * 失败只警告：对象元数据已改为 no-cache，缓存回源后仍会收敛。
 */
async function refreshCdn(config, urls) {
  for (const url of urls) {
    const path = `/refresh/${urlsafeBase64(url)}`;
    try {
      const response = await fetch(`https://fusion.qiniuapi.com${path}`, {
        method: "POST",
        headers: { Authorization: qboxAuthorization(config, `${path}\n`) },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      if (response.ok) {
        console.log(`[publish] CDN 刷新已提交：${url}`);
      } else {
        console.warn(`[publish] CDN 刷新失败（HTTP ${response.status}）：${url} ${text.slice(0, 160)}`);
      }
    } catch (error) {
      console.warn(`[publish] CDN 刷新异常：${url}（${error.message}）`);
    }
  }
}

// =====================================================================
// 发布流程
// =====================================================================

/** 流式计算本地文件 sha256（不整读进内存）。 */
function sha256OfFile(filePath) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** 流式计算远端对象 sha256（用于“同 key 不同内容”的对账）。 */
async function sha256OfRemote(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok) fail(`拉取远端对象失败 HTTP ${response.status}：${url}`);
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
}

/** HEAD 探测对象是否存在；只有 404/410 算不存在，其余（含网络错误）一律报错，避免误覆盖。 */
async function remoteObjectMissing(url) {
  let response;
  try {
    response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    fail(`HEAD 探测失败（不能确认远端状态，拒绝继续以免覆盖）：${url}\n${error.message}`);
  }
  if (response.status === 404 || response.status === 410) return true;
  if (!response.ok) fail(`HEAD ${url} 返回 HTTP ${response.status}（只把 404/410 视为不存在）`);
  return false;
}

/** 用仓库内公钥验签 manifest.sig 对 manifest.json 原始字节的签名；失败即中止。 */
function verifyManifestSignature(manifestBytes, sigFileBytes) {
  // manifest.sig 是 base64 文本，先解码成 64 字节的 Ed25519 签名
  const sigBytes = Buffer.from(sigFileBytes.toString("utf8").trim(), "base64");
  if (sigBytes.length !== 64) fail(`manifest.sig 解码后长度 ${sigBytes.length}，不是 Ed25519 的 64 字节签名`);
  const pem = readFileSync(publicKeyPath, "utf8");
  const publicKey = createPublicKey(pem);
  if (publicKey.asymmetricKeyType !== "ed25519") fail(`${relative(pluginRoot, publicKeyPath)} 不是 Ed25519 公钥`);
  const ok = verify(null, manifestBytes, publicKey, sigBytes);
  if (!ok) fail("manifest.sig 验签失败：sig 与 manifest.json 不匹配（重新执行 package-runtime.mjs 生成一致的产物）");
}

const apply = process.argv.includes("--apply");
// 测试域名（七牛测试域名只支持 HTTP）联调专用：必须显式给出，绝不作为默认行为。
const allowHttp = process.argv.includes("--allow-http");
const knownFlags = ["--apply", "--allow-http"];
if (process.argv.slice(2).some((arg) => !knownFlags.includes(arg))) {
  fail(`未知参数：${process.argv.slice(2).filter((arg) => !knownFlags.includes(arg)).join(" ")}（只支持 --apply / --allow-http）`);
}

// ---- 读本地产物 ----
const zipFiles = (await readdir(runtimeBuildDir))
  .filter((name) => /^zcode-runtime-.+\.zip$/.test(name))
  .sort();
if (zipFiles.length === 0) fail(`${runtimeBuildDir} 下没有 zcode-runtime-*.zip：先执行 scripts/package-runtime.mjs`);
if (zipFiles.length > 1) fail(`${runtimeBuildDir} 下有多个 zip，无法确定要发布哪个：${zipFiles.join(", ")}`);
const zipPath = resolve(runtimeBuildDir, zipFiles[0]);
const manifestPath = resolve(runtimeBuildDir, "manifest.json");
const sigPath = resolve(runtimeBuildDir, "manifest.sig");
for (const path of [manifestPath, sigPath]) {
  if (!existsSync(path)) fail(`缺少 ${relative(pluginRoot, path)}：先执行带签名步骤的 scripts/package-runtime.mjs`);
}

const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const sigBytes = readFileSync(sigPath);

// manifest.sha256 / size 必须与本地 zip 一致（发布的就是这份产物）
const localZipSha256 = await sha256OfFile(zipPath);
if (manifest.sha256 !== localZipSha256) {
  fail(`manifest.sha256 与本地 zip 不一致：manifest=${manifest.sha256} 本地=${localZipSha256}（重新执行 package-runtime.mjs）`);
}
if (typeof manifest.size === "number" && manifest.size !== statSync(zipPath).size) {
  fail(`manifest.size 与本地 zip 不一致：manifest=${manifest.size} 本地=${statSync(zipPath).size}`);
}

// 验签（本地操作，dry-run 也执行，提前暴露不一致）
verifyManifestSignature(manifestBytes, sigBytes);
console.log("[publish] manifest 验签通过（公钥：" + relative(pluginRoot, publicKeyPath) + "）");

// ---- 对象清单（顺序即上传顺序）----
// zip 的 key = manifest.archivePath（运行期就按这个 key 下载，必须原样）；
// manifest/sig 的 key 在 channel 层：zcode-ide/runtime/<channel>/manifest.{json,sig}。
const archiveKey = manifest.archivePath;
if (typeof archiveKey !== "string" || !archiveKey.endsWith("/zcode-runtime.zip")) {
  fail(`manifest.archivePath 不合法：${archiveKey}`);
}
const channelDir = archiveKey.split("/").slice(0, -2).join("/");
const objects = [
  { key: archiveKey, filePath: zipPath, size: statSync(zipPath).size, sha256: localZipSha256, contentType: "application/zip", immutable: true, cacheControl: "public, max-age=31536000, immutable" },
  { key: `${channelDir}/manifest.sig`, filePath: sigPath, size: sigBytes.length, sha256: createHash("sha256").update(sigBytes).digest("hex"), contentType: "application/octet-stream", immutable: false, cacheControl: "no-cache" },
  { key: `${channelDir}/manifest.json`, filePath: manifestPath, size: manifestBytes.length, sha256: createHash("sha256").update(manifestBytes).digest("hex"), contentType: "application/json", immutable: false, cacheControl: "no-cache" },
];

// ---- 环境变量 ----
const bucket = process.env.QINIU_BUCKET?.trim() || "zcode-ide";
const prefix = process.env.QINIU_PREFIX?.trim() || "zcode-ide";
const uploadHostEnv = process.env.QINIU_UPLOAD_HOST?.trim() || "https://up-z2.qiniup.com";
const domainRaw = process.env.QINIU_DOMAIN?.trim() || "";
const accessKey = process.env.QINIU_ACCESS_KEY?.trim() || "";
const secretKey = process.env.QINIU_SECRET_KEY?.trim() || "";

if (domainRaw && !domainRaw.startsWith("https://")) {
  if (!(allowHttp && domainRaw.startsWith("http://"))) {
    fail(`QINIU_DOMAIN 必须是 https:// 开头（测试域名联调请显式加 --allow-http），当前：${domainRaw}`);
  }
  console.warn("[publish] 警告：使用 HTTP 测试域名，仅限联调；生产必须使用 https:// 自有域名。");
}
const domain = domainRaw.replace(/\/+$/, "");
const config = { accessKey, secretKey, bucket };

if (!archiveKey.startsWith(`${prefix}/runtime/`)) {
  const message = `manifest.archivePath 前缀与 QINIU_PREFIX 不一致：archivePath=${archiveKey}，prefix=${prefix}`;
  if (apply) fail(message);
  console.warn(`[publish] ${message}（dry-run 继续）`);
}

console.log(`[publish] bucket=${bucket} prefix=${prefix}`);
console.log(`[publish] runtimeVersion=${manifest.runtimeVersion} channel=${manifest.channel}`);
console.log("[publish] 上传计划（顺序 zip → sig → manifest.json）：");
for (const [index, object] of objects.entries()) {
  console.log(`  ${index + 1}. key=${object.key}`);
  console.log(`     ${object.size} bytes  sha256=${object.sha256}  content-type=${object.contentType}${object.immutable ? "  [不可变：上传前先对账]" : ""}`);
}

if (!apply) {
  console.log("[publish] dry-run 完成：未发起任何网络请求。加 --apply 执行实际上传。");
  process.exit(0);
}

// ---- apply：必需变量检查（dry-run 缺失只影响计划完整性，上面已打印）----
const missingEnv = [
  ["QINIU_ACCESS_KEY", accessKey],
  ["QINIU_SECRET_KEY", secretKey],
  ["QINIU_DOMAIN", domain],
]
  .filter(([name, value]) => !value)
  .map(([name]) => name);
if (missingEnv.length > 0) fail(`--apply 需要环境变量：${missingEnv.join(", ")}`);

// ---- 区域发现：优先用查询结果，失败退回 QINIU_UPLOAD_HOST ----
const uploadHostState = { host: uploadHostEnv, regionFixed: false };
let rsHost;
if (accessKey && secretKey) {
  const hosts = await fetchRegionHosts(config);
  if (hosts.upload) uploadHostState.host = hosts.upload;
  rsHost = hosts.rs ?? deriveRsHost(uploadHostState.host);
  console.log(`[publish] 上传域名=${uploadHostState.host}  rs 域名=${rsHost}`);
} else {
  rsHost = deriveRsHost(uploadHostState.host);
}

// ---- 逐个上传 ----
for (const object of objects) {
  if (object.immutable) {
    // 版本路径不可变：远端已存在时必须内容一致，否则失败（升 runtimeVersion 重新打包）。
    const url = `${domain}/${object.key}`;
    const missing = await remoteObjectMissing(url);
    if (!missing) {
      const remoteSha256 = await sha256OfRemote(url);
      if (remoteSha256 === object.sha256) {
        console.log(`[publish] 跳过（远端已存在且 sha256 一致）：${object.key}`);
        continue;
      }
      fail(
        `远端已存在同 key 但内容不同：${object.key}\n  远端 sha256=${remoteSha256}\n  本地 sha256=${object.sha256}\n版本路径不可变，请升 runtimeVersion 重新打包，不要覆盖已发布版本。`,
      );
    }
  }

  const elapsedMs = await uploadObject(config, object, uploadHostState);
  console.log(`[publish] 已上传：${object.key}  ${object.size} bytes  ${(elapsedMs / 1000).toFixed(1)}s`);

  // MIME 修正：上传成功后 HEAD 检查 zip 的 Content-Type，不是 application/zip 就用 chgm 改。
  if (object.immutable) {
    const url = `${domain}/${object.key}`;
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
    const remoteMime = head.headers.get("content-type")?.split(";")[0]?.trim();
    if (head.ok && remoteMime !== object.contentType) {
      console.log(`[publish] 远端 Content-Type=${remoteMime ?? "（空）"}，用 chgm 修正为 ${object.contentType}`);
      const fixed = await changeMime(config, object.key, object.contentType, rsHost);
      if (!fixed) fail(`chgm 修正 MIME 失败：${object.key}`);
    }
  }
}

console.log("[publish] 完成：zip → manifest.sig → manifest.json 全部就绪。");
console.log(`[publish] manifest 地址：${domain}/${objects[2].key}`);

// 可变指针上传后立即刷新 CDN：对象元数据已是 no-cache，但边缘仍可能持有旧缓存（首次发布尤其明显）。
if (accessKey && secretKey) {
  await refreshCdn(
    config,
    objects.filter((object) => !object.immutable).map((object) => `${domain}/${object.key}`),
  );
}
