# 薄插件与 ZCode/Node 运行时分发方案（七牛云）

> 状态：**已实施（2026-10-25），按第 12 节任务 1–9 全部落地；与设计的偏差见第 14 节。**
> 适用仓库：`E:\work\zcode-ide`。
> 对象存储：七牛云，沿用 `E:\work\<your-bucket>` 的账号与上传实现。
> 目标：插件 zip ≈ 3.5 MB；ZCode runtime ≈ 44 MB；Node ≈ 30 MB；runtime 可独立检查、下载、更新、回滚。

本文档是实施规格，不是当前代码说明。落地时按第 12 节任务顺序执行，并在 `.agents/docs/changes/` 补变更记录。

---

## 0. 结论摘要

插件只保留 Kotlin 核心，ZCode runtime 和 Node 都改为按需下载：

| 对象 | 存放位置 | 大小 |
|---|---|---:|
| 插件 zip | Marketplace / 自建插件仓库 | 约 3.5 MB |
| ZCode runtime | `~/.zcode/ide/runtime/<version>/` | 44 MB 压缩 / 184 MB 解压 |
| Node 24 | `~/.zcode/ide/runtime-node/v<version>/` | 约 30 MB 压缩 |

- **插件自身不自更新**：由 IDE 的插件管理器从 Marketplace 或自建仓库更新。
- **runtime 由插件自己更新**：远端签名 manifest → 下载 → 校验 → pending → 下次启动 server 时切换 → 失败回滚。
- **七牛只做 runtime 分发**：Node 仍走 npmmirror / nodejs.org，不混在一起。
- **不裁剪 runtime**：官方 `dist/` 原样打包。

---

## 1. 目标与非目标

### 1.1 目标

1. `./gradlew buildPlugin` 默认产出不含 `runtime/` 的薄插件；
2. 首次打开 ZCode ToolWindow 时自动检查并下载 runtime；
3. runtime 支持独立版本、独立发布、独立更新；
4. 更新不打断正在运行的对话，只在下次 server 启动时生效；
5. 下载/解压/启动失败可回滚；
6. 离线/内网可用本地 runtime 或完整包；
7. 插件更新只有约 3.5 MB。

### 1.2 非目标

- 不做 runtime 裁剪；
- 不做按平台拆包（v1 用 Windows 构建的通用包，包含各平台 prebuild）；
- 不做插件自替换；
- 不做组件级增量下载（v1 整包下载，后续再拆 web/server/agent）；
- 不把七牛 AK/SK 放进插件或 manifest。

### 1.3 已确认决策

| 项 | 决定 |
|---|---|
| 插件包 | 只含 Kotlin 核心 + baseline manifest + 公钥 |
| runtime 目录 | `~/.zcode/ide/runtime/<version>/` |
| Node 目录 | `~/.zcode/ide/runtime-node/` |
| manifest | 内置 baseline + 远端签名 manifest |
| 签名 | Ed25519，私钥只在 CI |
| 更新时机 | 后台下载，下次启动 server 时切换 |
| 插件更新 | Marketplace / 自建 `updatePlugins.xml` |
| 构建 | 必须 Windows runner |
| 完整包 | `-PbundleRuntime=true` 保留，供离线使用 |

---

## 2. 现状与目标对比

| 项 | 现状 | 目标 |
|---|---|---|
| 插件 zip | 约 51 MB（含 runtime） | 约 3.5 MB |
| runtime 位置 | 插件目录 `plugins/zcode-ide/runtime/` | `~/.zcode/ide/runtime/<version>/` |
| Node 位置 | 插件目录 `runtime-node/`，不可写时用户目录 | 固定 `~/.zcode/ide/runtime-node/` |
| runtime 更新 | 随插件更新整体替换 | 独立 manifest 检查/下载/切换/回滚 |
| 插件更新 | 手工/CI 出包 | IDE 插件管理器（Marketplace/自建仓库） |
| 首次下载 | 51 MB，另加 Node（如缺失） | 3.5 + 44 MB，另加 Node（如缺失） |
| 离线 | 完整包可用 | `ZCODE_IDE_RUNTIME` 或 `-PbundleRuntime=true` |

---

## 3. 七牛云配置

### 3.1 账号与 bucket

`<your-bucket>` 的七牛配置位于 `E:\work\<your-bucket>\server\.env`，关键项：

```bash
QINIU_ACCESS_KEY=...        # 不复制到本仓库
QINIU_SECRET_KEY=...        # 不复制到本仓库
QINIU_BUCKET=<your-bucket>
QINIU_DOMAIN=http://tnbe4cmeo.hn-bkt.clouddn.com
QINIU_PREFIX=<your-bucket>
QINIU_UPLOAD_HOST=https://up-z2.qiniup.com
```

已确认：

- bucket 在**华南区域**，上传域名是 `up-z2.qiniup.com`；
- `tnbe4cmeo.hn-bkt.clouddn.com` 是**七牛测试域名**：只支持 HTTP、30 天回收、每日 10 GB 回源限制；
- **不能把测试域名用于插件 runtime**。插件要求 HTTPS，而且测试域名会过期。

### 3.2 推荐配置

**首选：在同一七牛账号下新建 bucket `zcode-ide`**，和 `<your-bucket>` 隔离。好处是 CDN 缓存、生命周期、权限、配额互不影响。

如果确定复用 `<your-bucket>` bucket，必须：

- 对象键统一加前缀 `zcode-ide/`；
- 使用独立的 CDN 域名或路径规则；
- 确认 <your-bucket> 的生命周期/清理规则不会删除 `zcode-ide/`。

生产域名必须是：

```text
https://cdn.example.com
```

要求：

1. 自有域名，完成 ICP 备案（大陆 CDN 必需）；
2. 配置有效 HTTPS 证书；
3. 开启强制 HTTPS；
4. bucket/CDN 允许公开读取；
5. 关闭 Referer 防盗链，或允许空 Referer——插件用 Java `HttpClient` 下载，不带浏览器 Referer；
6. 不需要 CORS（JVM 下载不受浏览器同源限制）。

### 3.3 对象键与缓存

前缀固定为 `zcode-ide/`：

```text
zcode-ide/runtime/stable/manifest.json
zcode-ide/runtime/stable/manifest.sig
zcode-ide/runtime/stable/<runtimeVersion>/zcode-runtime.zip
```

示例：

```text
https://cdn.example.com/zcode-ide/runtime/stable/manifest.json
https://cdn.example.com/zcode-ide/runtime/stable/manifest.sig
https://cdn.example.com/zcode-ide/runtime/stable/0.1.0-cf345dcb7d0a/zcode-runtime.zip
```

CDN 缓存规则：

| 路径 | 缓存 |
|---|---|
| `runtime/*/manifest.json` | 不缓存或 1 分钟 |
| `runtime/*/manifest.sig` | 不缓存或 1 分钟 |
| `runtime/*/*/zcode-runtime.zip` | 1 年，immutable |

manifest 更新后如果 CDN 仍有缓存，用七牛 CDN 刷新，或在插件请求时加 `?t=<epoch>`；同时确认 CDN 缓存键包含查询参数。

### 3.4 环境变量

插件构建/发布侧：

```bash
QINIU_ACCESS_KEY=...
QINIU_SECRET_KEY=...
QINIU_BUCKET=zcode-ide            # 或 <your-bucket>
QINIU_DOMAIN=https://cdn.example.com
QINIU_PREFIX=zcode-ide
QINIU_UPLOAD_HOST=https://up-z2.qiniup.com

RUNTIME_SIGNING_KEY=...           # Ed25519 私钥 PEM 或 base64
```

插件运行侧：

```bash
ZCODE_DATA_BASE_DIR=...                    # 可选，覆盖 ~/.zcode
ZCODE_IDE_RUNTIME=...                      # 本地 runtime，设置后跳过下载
ZCODE_IDE_RUNTIME_MANIFEST_URL=...         # 覆盖 manifest 地址
ZCODE_IDE_RUNTIME_BASE_URL=...             # 覆盖 archive 基础地址
ZCODE_IDE_RUNTIME_CHANNEL=stable|beta
ZCODE_IDE_RUNTIME_AUTO_UPDATE=0            # 关闭自动检查
```

### 3.5 上传实现：复用 <your-bucket> 的七牛代码

`<your-bucket>/uploader/src/qiniu.ts` 已经用 Node 内置能力实现了七牛上传，不依赖 SDK，直接复用其思路：

1. **上传凭证**
   - `putPolicy`：`scope=<bucket>:<key>`、`deadline=now+3600`、`insertOnly=0`；
   - `urlsafeBase64`：只把 `+` `/` 换成 `-` `_`，**必须保留结尾 `=` padding**；
   - 签名：`HMAC-SHA1(secretKey, encodedPolicy)`，再 urlsafe base64；
   - token 格式：`AK:sign:encodedPolicy`。

2. **区域发现**
   - `GET https://uc.qbox.me/v4/query?ak=<AK>&bucket=<bucket>`；
   - `Authorization: QBox <AK>:<urlsafe(HMAC-SHA1(secret, path+"\n"))>`；
   - 取 `hosts[0].up.domains[0]`；
   - 失败时退回 `https://up-z2.qiniup.com`；
   - 上传返回 `400 incorrect region, please use up-z2.qiniup.com` 时按提示切换一次。

3. **上传方式**
   - 流式 `multipart/form-data`，文件不读进内存；
   - 必须带 `Content-Length`，不能 chunked；
   - Node `fetch` 需要 `duplex: 'half'`；
   - 单文件 44 MB 沿用 <your-bucket> 已验证的表单上传；
   - 如果七牛返回 `413` 或 `RequestEntityTooLarge`，改走七牛分片上传 API（或 `qshell rput`）。

4. **MIME**
   - 上传时 multipart 文件部分设 `Content-Type: application/zip`；
   - 如果 CDN 返回错误 MIME，用七牛 `chgm` 接口修正：
     `POST https://rs-z2.qbox.me/chgm/<urlsafe(bucket:key)>/mime/<urlsafe(application/zip)>`。

5. **上传顺序**
   ```
   zcode-runtime.zip  →  manifest.sig  →  manifest.json
   ```
   manifest 最后上传，避免客户端拿到指向不存在 zip 的 manifest。

### 3.6 发布脚本

新增 `scripts/publish-runtime.mjs`：

- 默认 dry-run，`--apply` 才上传；
- 读取 `build/runtime/` 下的 zip、manifest、sig；
- 上传 zip 时校验远端是否已存在：
  - 同 key 同 sha256：跳过；
  - 同 key 不同 sha256：失败（版本路径不可变，必须发新版本）；
- 上传 manifest 前重新读取并校验签名；
- 打印每个对象的 key、大小、耗时，不打印 AK/SK。

---

## 4. Manifest 与签名

### 4.1 版本模型

| 字段 | 示例 | 规则 |
|---|---|---|
| `pluginVersion` | `0.1.0` | Gradle `pluginVersion` |
| `runtimeVersion` | `0.1.0+cf345dcb7d0a` | `pluginVersion + fork commit 前 12 位` |
| `runtimeApiVersion` | `1` | 插件↔runtime 契约版本，契约变化时 +1 |
| `nodeVersion` | `24.14.0` | manifest 锁定，不追最新 |

### 4.2 Manifest 格式

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "runtimeVersion": "0.1.0+cf345dcb7d0a",
  "runtimeApiVersion": 1,
  "minPluginVersion": "0.1.0",
  "maxPluginVersion": "0.1.*",
  "nodeVersion": "24.14.0",
  "archivePath": "zcode-ide/runtime/stable/0.1.0-cf345dcb7d0a/zcode-runtime.zip",
  "sha256": "……",
  "size": 46137344,
  "uncompressedSize": 199066532,
  "builtAt": "2026-10-25T07:28:29.739Z",
  "forkCommit": "cf345dcb7d0af835951076bcd6192efeba6ecfa3",
  "notes": "可选更新说明"
}
```

插件端用 `kotlinx.serialization` 解析，`ignoreUnknownKeys = true`。

`archivePath` 是相对 CDN 根的完整对象键；默认基础地址为 `https://cdn.example.com/`，可用 `ZCODE_IDE_RUNTIME_BASE_URL` 覆盖。

### 4.3 签名

- 算法：Ed25519；
- 签名对象：`manifest.json` 的**原始字节**；
- 产物：`manifest.sig`（base64）；
- 公钥：`src/main/resources/runtime-signing-public.pem`；
- 私钥：CI Secret `RUNTIME_SIGNING_KEY`。

生成密钥：

```bash
openssl genpkey -algorithm ED25519 -out runtime-signing-private.pem
openssl pkey -in runtime-signing-private.pem -pubout -out runtime-signing-public.pem
```

Node 签名：

```js
const signature = crypto.sign(null, manifestBytes, privateKeyPem);
```

Kotlin 验签：

```kotlin
val key = KeyFactory.getInstance("Ed25519")
    .generatePublic(X509EncodedKeySpec(publicKeyBytes))
Signature.getInstance("Ed25519").run {
    initVerify(key)
    update(manifestBytes)
    verify(signatureBytes)
}
```

验签失败：忽略远端 manifest，回退内置 baseline，记录日志并最多提示一次。

### 4.4 兼容判断

下载前检查：

```text
schemaVersion == 1
runtimeApiVersion == 当前插件支持值
pluginVersion ∈ [minPluginVersion, maxPluginVersion]
sha256/size 合法
签名有效
```

任何一项失败：不下载，继续使用当前 runtime。

---

## 5. 构建与发布

### 5.1 `scripts/package-runtime.mjs`

输入：

- `dist/`（`build-runtime.mjs` 产物）
- `dist/BUILD-INFO.json`
- `gradle.properties`

输出：

```text
build/runtime/
├── zcode-runtime-0.1.0+cf345dcb7d0a.zip
├── manifest.json
└── manifest.sig
```

职责：

1. 校验必需文件：
   - `server/entry-http.js`
   - `web/index.html`
   - `agent/zcode.cjs`
   - `remote-bridge/index.mjs`
   - `LICENSE`
   - `NOTICE.md`
   - `THIRD-PARTY-NOTICES.md`
2. 以 `dist/` 内容为 zip 根，不额外包一层目录；
3. 用 `yazl` 生成确定性 zip：排序条目、固定 mtime、统一压缩；
4. 计算 SHA-256 和 size；
5. 校验 `BUILD-INFO.json.locked === true`（CI）；
6. 生成 manifest；
7. 用 `RUNTIME_SIGNING_KEY` 签 manifest；
8. `--write-manifest` 时写入 `src/main/resources/runtime-manifest.json`；
9. `--require-sign` 时缺少私钥直接失败。

命令：

```bash
node scripts/build-runtime.mjs
node scripts/package-runtime.mjs --write-manifest --require-sign
```

### 5.2 Gradle 薄/全切换

`build.gradle.kts`：

```kotlin
val bundleRuntime = providers.gradleProperty("bundleRuntime")
    .map(String::toBoolean)
    .orElse(false)

val copyRuntimeToSandbox by tasks.registering {
    // 现有逻辑保持不变
}

tasks.named("buildPlugin") {
    if (bundleRuntime.get()) dependsOn(copyRuntimeToSandbox)
}
```

命令：

```bash
./gradlew buildPlugin                       # 薄包，约 3.5 MB
./gradlew buildPlugin -PbundleRuntime=true  # 完整包，约 51 MB
```

资源：

- `src/main/resources/runtime-manifest.json`
- `src/main/resources/runtime-signing-public.pem`

### 5.3 CI 流程

Windows runner，顺序严格：

```text
node scripts/ci-build.mjs --thin
  ├─ 准备 fork / 锁校验 / patch budget
  ├─ pnpm install + 构建 web/server/agent/remote-bridge
  ├─ node scripts/build-runtime.mjs
  └─ node scripts/package-runtime.mjs --write-manifest --require-sign

node scripts/publish-runtime.mjs --apply
  ├─ 上传 zip
  ├─ 上传 manifest.sig
  └─ 上传 manifest.json

./gradlew buildPlugin
  └─ 薄插件，manifest 已在 resources 里

# 可选
./gradlew publishPlugin
```

失败规则：

- runtime 构建/签名/上传任一步失败 → 不构建、不发布插件；
- manifest 上传失败 → 插件不能发布，因为 baseline 会指向不存在的对象；
- zip 已存在且 hash 不同 → 失败，要求升 runtimeVersion。

### 5.4 发布命令（人工）

```bash
export QINIU_ACCESS_KEY=...
export QINIU_SECRET_KEY=...
export QINIU_BUCKET=zcode-ide
export QINIU_DOMAIN=https://cdn.example.com
export QINIU_PREFIX=zcode-ide
export QINIU_UPLOAD_HOST=https://up-z2.qiniup.com
export RUNTIME_SIGNING_KEY="$(cat runtime-signing-private.pem)"

node scripts/build-runtime.mjs
node scripts/package-runtime.mjs --write-manifest --require-sign
node scripts/publish-runtime.mjs --apply

./gradlew buildPlugin
```

验证：

```bash
curl -I "https://cdn.example.com/zcode-ide/runtime/stable/manifest.json"
curl -I "https://cdn.example.com/zcode-ide/runtime/stable/manifest.sig"
curl -I "https://cdn.example.com/zcode-ide/runtime/stable/0.1.0-cf345dcb7d0a/zcode-runtime.zip"
```

---

## 6. 运行期实现

### 6.1 新增/修改文件

| 文件 | 职责 |
|---|---|
| `runtime/RuntimeManifest.kt` | manifest 数据类、解析、版本比较、兼容检查 |
| `runtime/RuntimeProvisioner.kt` | 检查/下载/续传/校验/解压/锁/指针/清理 |
| `runtime/RuntimeUpdater.kt` | 远端 manifest、签名校验、后台下载、pending/promote/rollback |
| `runtime/RuntimeLayout.kt` | 增加用户目录候选；复用 `fromRoot` |
| `runtime/NodeProvisioner.kt` | 用户目录、锁定 Node 版本 |
| `runtime/ServerProcess.kt` | 记录 runtimeVersion，版本变化禁止复用旧 server |
| `service/ZCodeServerManager.kt` | 启动前 ensure；pending 优先启动与回滚 |
| `ui/ZCodePanel.kt` | 下载进度、失败重试、更新通知 |
| `settings/ZCodeRuntimeConfigurable.kt` | 自动更新、渠道、镜像、清理缓存 |
| `resources/META-INF/plugin.xml` | 注册设置页；复用 `ZCodeIDE` 通知组 |

### 6.2 首次安装流程

```text
首次打开 ToolWindow
└─ ZCodePanel 后台线程
   └─ ZCodeServerManager.url(status)
      ├─ RuntimeProvisioner.ensure(status)
      │  ├─ -Dzcode.ide.runtime / ZCODE_IDE_RUNTIME
      │  ├─ vendor/ZCode（开发期）
      │  ├─ 插件自带 runtime（完整包）
      │  ├─ ~/.zcode/ide/runtime/current
      │  └─ 都没有 → 按 baseline manifest 下载
      │     ├─ 检查磁盘空间
      │     ├─ 加 .lock
      │     ├─ 下载到 <version>.part（Range 续传）
      │     ├─ 校验 size + sha256
      │     ├─ 解压到 <version>.staging-<uuid>
      │     ├─ 校验必需文件
      │     ├─ 设置 darwin spawn-helper 0755
      │     ├─ 原子 rename 成 <version>
      │     ├─ 写 .complete.json
      │     └─ 写 current.json
      ├─ NodeProvisioner.ensure(status, manifest.nodeVersion)
      └─ ServerProcess(layout, node).start()
```

状态文案：

```text
正在下载 ZCode 运行时 12.4 / 44.0 MB…
正在校验 ZCode 运行时…
正在解压 ZCode 运行时…
正在启动 ZCode server…
```

失败时显示错误和“重试”按钮，不要把页面留白。

### 6.3 更新流程

```text
ToolWindow 打开 / IDE 启动后延迟
└─ RuntimeUpdater.checkInBackground()
   ├─ 距上次检查 < 24h → 跳过
   ├─ 拉远端 manifest + manifest.sig
   ├─ 验签失败 → 忽略远端，使用 baseline
   ├─ 版本不新/不兼容 → 结束
   └─ 新版本 → 下载到独立版本目录
      └─ 写 pending.json
         ├─ 通知「运行时更新已下载，重启 ZCode 后生效」
         └─ 下次 ZCodeServerManager.url()
            ├─ 先用 pending 启动
            ├─ 成功 → promote，current=pending，清理旧版本
            └─ 失败 → rollback，删除 pending，继续用 current
```

规则：

- server 正在运行时不切换，只下载 + 通知；
- 用户点通知里的“重启 ZCode”才调 `ZCodeServerManager.restart()`；
- 没有活跃 server 时，pending 可以在下次打开面板时直接生效；
- `promote` 只在 `ServerProcess.start()` 成功后执行；
- 失败保留 pending 目录供排查，但指针回滚到 current。

### 6.4 存储、指针、锁

```text
~/.zcode/ide/runtime/
├── .lock
├── current.json
├── pending.json
├── <version>/
│   ├── .complete.json
│   ├── web/
│   ├── server/
│   ├── agent/
│   ├── node_modules/
│   ├── remote-bridge/
│   ├── LICENSE
│   ├── NOTICE.md
│   ├── THIRD-PARTY-NOTICES.md
│   └── BUILD-INFO.json
└── <version>.part
```

`current.json` / `pending.json`：

```json
{
  "version": "0.1.0+cf345dcb7d0a",
  "path": "0.1.0-cf345dcb7d0a",
  "sha256": "……",
  "installedAt": "2026-10-25T12:00:00Z"
}
```

规则：

- 只有 `.complete.json` 存在且 hash 匹配的目录才会被使用；
- 指针用“临时文件 + `ATOMIC_MOVE`”写；
- `.lock` 用 `FileChannel.lock()`，多个 IDE 进程只允许一个下载；
- 清理：保留 current、pending、上一版；删除其它版本和超过 7 天的 `.part`；
- `ZCODE_DATA_BASE_DIR` 优先，否则 `~/.zcode`。

### 6.5 Server 复用与 runtime 版本

`ServerProcess.start()` 会复用上一次 IDE 会话留下的同端口同 token server。runtime 更新后必须处理：

1. `ServerProcess` 记录 `runtimeVersion`，启动成功后写入 `PropertiesComponent`；
2. 下次启动比较持久化版本与当前 layout：
   - 不同且旧进程是子进程 → `killTree`；
   - 不同且是 `reused` 进程 → 按端口找 PID 并结束；
     - Windows：`netstat -ano -p tcp` + `taskkill /PID <pid> /T /F`
     - Unix：`lsof -ti tcp:<port>` + `kill -9`
   - 找不到 PID → 换新端口并记录警告（会重置该 origin 的 localStorage，作为最后手段）；
3. 启动成功后更新持久化版本；
4. `restart()` 后重新 `RuntimeLayout.resolve()`，不要缓存旧 layout。

### 6.6 Node 策略

`NodeProvisioner` 改动：

- `installRoot()` 改为 `~/.zcode/ide/runtime-node`；
- `ensure(status, pinnedVersion: String?)`：
  1. 本机 Node 24.x → 直接用（记录版本）；
  2. 用户目录已安装 24.x → 复用；
  3. 否则下载 manifest 里的 `nodeVersion`，用 `SHASUMS256.txt` 校验；
  4. 原子安装到 `v<version>`，保留旧版本；
- 不自动追最新 Node；
- 从插件目录迁移旧 `runtime-node`：best-effort 复制/移动，失败则重新下载；
- Node 镜像仍用 npmmirror，失败回落 nodejs.org。

### 6.7 UI、设置与通知

设置页：

- 自动检查更新（默认开）
- 渠道 stable / beta
- manifest URL / 镜像 Base URL
- 当前版本：插件 / runtime / Node
- “立即检查”
- “清理运行时缓存”

通知复用 `plugin.xml` 里的 `ZCodeIDE` 通知组：

- 更新可用 / 已下载
- 下载失败（重试）
- 已回滚到上一版本

环境变量优先级高于设置页。

---

## 7. 插件自身更新

### 7.1 公开分发：Marketplace

- 插件包只有约 3.5 MB，IDE 的插件管理器负责更新；
- 每次发版改 `pluginVersion` 和 `changeNotes`；
- 插件不要自己替换 jar。

### 7.2 内部分发：自建插件仓库

七牛上放：

```text
zcode-ide/plugin/updatePlugins.xml
zcode-ide/plugin/zcode-ide-0.1.1.zip
```

`updatePlugins.xml`：

```xml
<plugins>
  <plugin id="dev.zcode.ide"
          url="https://cdn.example.com/zcode-ide/plugin/zcode-ide-0.1.1.zip"
          version="0.1.1">
    <idea-version since-build="251" until-build="263.*"/>
    <name>ZCode IDE</name>
    <description>...</description>
    <change-notes>...</change-notes>
    <vendor>Your Org</vendor>
  </plugin>
</plugins>
```

用户在 `Settings → Plugins → Manage Plugin Repositories` 添加 XML URL。IDE 的插件更新检查会读取它；更新提示/自动下载仍受用户 IDE 设置控制。

### 7.3 不自更新

不在插件里下载并替换自己的 jar：

- Windows 上 jar 被 IDE 锁定，必须外部进程等待 IDE 退出；
- 需要改插件目录、备份、回滚、重启 IDE；
- 绕过 Marketplace 签名/审核；
- 风险远大于收益。

---

## 8. 安全模型

1. manifest 必须 Ed25519 验签，失败回退 baseline；
2. archive 必须匹配 `size` + `sha256`；
3. 只接受 HTTPS；
4. 只下载 manifest 指定版本，不请求 latest；
5. zip 解压做 zip-slip 校验，拒绝绝对路径和 `..`；
6. 只有完整解压 + 校验 + 原子 rename 后才允许 server 启动；
7. 解压后设置 `darwin-*/spawn-helper` 为 0755；
8. 七牛 bucket 公开读，写权限只在 CI；
9. 日志不打印 AK/SK、私钥、token；
10. 新 runtime 启动失败必须回滚 current。

---

## 9. 迁移与兼容

| 场景 | 处理 |
|---|---|
| 已有完整插件 | `RuntimeLayout` 继续找到插件自带 runtime；薄插件更新后转下载 |
| 开发期 `vendor/ZCode` | 仍然优先，不受下载逻辑影响 |
| 离线/内网 | `ZCODE_IDE_RUNTIME` 本地目录，或 `-PbundleRuntime=true` |
| 旧 `runtime-node` 在插件目录 | 尝试迁移到用户目录，失败重下 |
| 旧 server 被复用 | 按 runtimeVersion 检测并强制重启/换端口 |
| 上一版 runtime | 保留用于回滚；成功启动后清理更旧版本 |
| 多个 IDE 版本共用 | 共用 `~/.zcode/ide/runtime`，文件锁保证并发安全 |

---

## 10. 测试与验收

### 10.1 单元测试

- manifest 解析、缺字段、未知字段；
- 版本比较与兼容判断；
- Ed25519 验签成功/失败；
- SHA-256、size 校验；
- zip entry 路径校验；
- current/pending 原子写；
- `RuntimeLayout` 候选顺序。

### 10.2 手工验收矩阵

| 场景 | 预期 |
|---|---|
| 全新安装，无 runtime，有 Node 24 | 下载 44 MB，启动成功 |
| 全新安装，无 runtime，无 Node | runtime + Node 都下载 |
| 已有 runtime，无更新 | 不下载，直接启动 |
| 远端有新 runtime | 后台下载，通知，重启后生效 |
| 下载中断 | 下次续传 |
| hash 不匹配 | 不安装，报错可重试 |
| 两个 IDE 同时启动 | 一个下载，另一个等待 |
| 离线 + `ZCODE_IDE_RUNTIME` | 正常启动 |
| 离线 + 无 runtime | 明确报错 |
| pending runtime 启动失败 | 回滚 current |
| runtime 更新后旧 server 还在 | 强制重启或换端口 |
| `-PbundleRuntime=true` | 完整包离线启动 |
| macOS | spawn-helper 可执行，终端可用 |
| Marketplace 安装 | 插件包 < 5 MB，首次下载正常 |

### 10.3 命令

```bash
node scripts/build-runtime.mjs
node scripts/package-runtime.mjs --write-manifest --require-sign
./gradlew test
./gradlew buildPlugin
unzip -l build/distributions/zcode-ide-0.1.0.zip | grep runtime   # 薄包应为空
./gradlew buildPlugin -PbundleRuntime=true
./gradlew verifyPluginProjectConfiguration
node scripts/check-change-log.mjs
```

---

## 11. 运维手册

### 11.1 发布新 runtime

1. 在 fork 提交改动，跑 `node scripts/bootstrap.mjs --update` 更新 `vendor/zcode.lock`；
2. `node scripts/build-runtime.mjs`；
3. `node scripts/package-runtime.mjs --write-manifest --require-sign`；
4. `node scripts/publish-runtime.mjs --apply`；
5. 用 `curl -I` 验证 manifest、sig、zip；
6. `./gradlew buildPlugin` 出薄插件；
7. 发布插件与 npm 安装器：`node scripts/release.mjs --apply --push --npm`
   （默认 dry-run；版本取自 `scripts/npm/package.json`）。

### 11.2 回滚

- **runtime 回滚**：在七牛上把 `manifest.json` 指回上一版（旧版本 zip 仍保留），客户端下次检查自动降级/回滚；或让用户删除 pending。
- **插件回滚**：Marketplace 回退版本，或修改 `updatePlugins.xml` 指回旧 zip。
- 保留最近 **3 个 runtime 版本**，其余按生命周期规则清理。

### 11.3 换 CDN 域名

- 保留旧域名一段时间；
- 发布新插件，内置新的 `ZCODE_IDE_RUNTIME_BASE_URL`；
- 或使用稳定 CNAME，避免改插件。

### 11.4 轮换签名密钥

1. 新公私钥生成；
2. 插件先内置新旧两把公钥（发布一版）；
3. 再用新私钥签 manifest；
4. 旧公钥保留一个版本周期后移除。

### 11.5 清理用户缓存

```bash
rm -rf ~/.zcode/ide/runtime
rm -rf ~/.zcode/ide/runtime-node
```

或在设置页点“清理运行时缓存”。

### 11.6 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `401 BadToken` | urlsafe base64 丢了 `=` padding；AK/SK 错；token 过期 | 保留 padding；检查 AK/SK |
| `400 incorrect region` | 用了华东上传域名 | 用 `up-z2.qiniup.com` 或区域发现 |
| `413 RequestEntityTooLarge` | 表单上传限制 | 改用七牛分片上传 / `qshell rput` |
| HTTPS 证书错误 | 用了七牛测试域名 | 绑定自有域名 + 证书 |
| 下载 403 | CDN 开了 Referer 防盗链 | 关闭防盗链或允许空 Referer |
| manifest 404 | 上传顺序错/路径错 | 先传 zip，再 sig，最后 manifest |
| hash 不一致 | zip 被覆盖/上传不完整 | 重新打包并生成新 manifest |
| 客户端还拿旧 manifest | CDN 缓存 | 刷新 CDN 或加 `?t=` |
| 测试域名突然失效 | 30 天回收/10GB 日限 | 改用自有域名 |

---

## 12. 任务拆解

| # | 任务 | 产出 | 预估 |
|---|---|---|---|
| 1 | 七牛上传库 + 打包脚本 | `package-runtime.mjs`、`publish-runtime.mjs`、签名 | 1.5 天 |
| 2 | Gradle 薄/全切换 | `-PbundleRuntime`、baseline manifest | 0.5 天 |
| 3 | RuntimeProvisioner | 下载/续传/hash/解压/锁/指针/清理 | 2 天 |
| 4 | 服务集成 | `RuntimeLayout`、`ZCodeServerManager`、pending/rollback、server 复用 | 1.5 天 |
| 5 | RuntimeUpdater | 远端签名 manifest、24h 检查、通知 | 1 天 |
| 6 | Node 调整 | 用户目录、锁定版本、迁移 | 0.5 天 |
| 7 | UI/设置 | 进度、重试、设置页 | 1 天 |
| 8 | CI/七牛 | workflow、Secrets、上传验证 | 1 天 |
| 9 | 测试/文档/验收 | 单测、手工矩阵、变更记录 | 2 天 |

合计约 **10–11 个工作日**。

---

## 13. 风险与待确认

1. **七牛测试域名不能用于生产**：必须绑定自有 HTTPS 域名；大陆 CDN 需要备案。
2. **bucket 选择**：推荐新建 `zcode-ide`；复用 `<your-bucket>` 时必须隔离前缀和 CDN 规则。
3. **首包大小没有变**：首次总下载约 48 MB（有 Node）/ 78 MB（无 Node）；拆包主要优化插件更新和 runtime 独立发版。
4. **Marketplace 审核**：插件运行期下载 44 MB 可执行代码，需要在描述和隐私政策中说明签名/校验/本地绑定。
5. **Windows 旧 server 复用**：runtime 更新后必须处理，否则会继续跑旧代码。
6. **macOS 可执行位**：解压后必须补 `spawn-helper` 权限。
7. **签名私钥保管**：丢失后无法给已发布插件签新 manifest，需要预留轮换方案。
8. **七牛大文件上传**：44 MB 表单上传已验证可行；仍需准备分片上传兜底。
9. **CDN 缓存与防盗链**：manifest 不能长缓存，runtime 必须允许空 Referer。
10. **不裁剪 runtime**：PDB 等仍占约 11 MB 压缩体积，首包比裁剪版大。

---

## 14. 实施落地记录（2026-10-25）

按第 12 节任务 1–9 全部落地（Task A–G，逐任务报告在 `.superpowers/sdd/RUNTIME-DISTRIBUTION/`）。与设计的偏差：

| 项 | 设计 | 落地 | 原因 |
|---|---|---|---|
| Gradle 薄/全切换 | `bundleRuntime=true` 才 `dependsOn(copyRuntimeToSandbox)` | 反向新增 `stripRuntimeFromSandbox`：薄包必删沙箱残留 `runtime/` | `prepareSandbox` 不清空沙箱，全→薄不 clean 会把 51MB runtime 打进"薄包"（实测 5891 条目） |
| 下载读超时 | 「读超时 60s」 | 响应头超时 60s + body 停滞看门狗（60s 无新字节关流中止，`.part` 保留续传） | HttpClient 的 timeout 管不到 body 流；远端停滞会永久持 `.lock` 拖死其他 IDE |
| 文件锁 | `FileChannel.lock()` | `tryLock()` 捕获 `OverlappingFileLockException` 按锁被占处理 | 同 JVM 重入抛异常而非返回 null，不捕获则同进程第二次 `ensure()` 直接崩 |
| pending 分支的 Node 版本 | （未明确） | `pinnedNodeVersion()` 同源化：常规与 pending 分支共用 `baseline.nodeVersion` 唯一来源 | 防两处来源漂移 |
| 设置页优先级链 | env > 设置页 > 默认 | 收敛到 `RuntimeSettings.settingValue`（系统属性 > env > 设置页 > 默认），落在 `RuntimeProvisioner.kt` 文件尾 | 四处解析共用一条链防漂移；简报未含新文件故不单独建文件 |
| intellij-platform 插件 | 未提及 | 2.1.0 → 2.2.1 | 修复 `./gradlew test` 开箱崩溃；2.18+ 需 Gradle 9 而 wrapper 是 8.13 |
| CI 发布开关 | `publish-runtime.mjs --apply` | workflow_dispatch input `publishRuntime` → `CI_PUBLISH_RUNTIME=1`；tag push 一律不发布；额外上传 `zcode-runtime-package` artifact | 人工显式触发，防误发布 |
| 签名密钥 | 私钥只在 CI | 已生成于 `~/.zcode/keys/runtime-signing-private.pem`；公钥入库 `src/main/resources/runtime-signing-public.pem` | CI 侧仍走 Secret `RUNTIME_SIGNING_KEY` |
| CDN 域名 | `https://cdn.example.com` 占位 | **仍为占位**：bucket/CDN 未建、`publish-runtime.mjs` 未真上传过；baseline 已与 dist/锁对齐（`0.1.0+b177da31c187`） | 待办：建 bucket + 备案域名 + CI Secrets + 真上传 |
| `ZCODE_DATA_BASE_DIR` 语义 | 统一覆盖 `~/.zcode`（插件数据根，§3.4/附录 B） | 语义分裂：`RuntimeLayout` 视为替换 `~/.zcode`，`NodeProvisioner`/`IdeBridge` 视为替换 `~`——env 生效时 runtime 与 Node 分居两根 | 两处实现各自沿用旧语义未对齐；最终评审 F-2，先如实记录，待收敛 |
| 运行时源协议 | 只接受 HTTPS（§8.3） | 保留 HTTPS 默认；新增**显式**调试开关 `ZCODE_IDE_RUNTIME_ALLOW_HTTP=1`（或系统属性 `zcode.ide.runtime.allowHttp`）放行 `http://`，首次放行日志告警一次 | 七牛测试域名只支持 HTTP，联调需要；默认关闭、不读设置页，生产行为不变 |
| CDN 缓存策略（manifest） | manifest/sig 不缓存或 1 分钟，更新后刷新 CDN 或加 `?t=` | **实测测试域名**：默认 `max-age=31536000`、`?t=` 无效（缓存键不含 query）、表单 `Cache-Control` 未写入元数据、刷新 API 401（AK 无 CDN 权限）→ 测试环境用新 channel 路径（`test`）规避；正式域名须在控制台配缓存规则 + 每次发布后刷新 | 不处理则客户端最长一年看不到新版本；`publish-runtime.mjs` 已带 `Cache-Control` 与刷新调用，正式域名/权限就绪后自动生效 |

单元测试 130 个（方案 §10.1 全项，含 Windows 风格 zip-slip 条目、`PLUGIN_VERSION` ↔ `gradle.properties` 一致性护栏、HTTP 调试开关放行/拒绝分支）；本地验收矩阵与实机清单见 `.superpowers/sdd/RUNTIME-DISTRIBUTION/task-G-report.md`。

---

## 附录 A：新增/修改文件清单

```text
scripts/package-runtime.mjs          新增
scripts/publish-runtime.mjs          新增

src/main/kotlin/dev/zcode/ide/runtime/RuntimeManifest.kt       新增
src/main/kotlin/dev/zcode/ide/runtime/RuntimeProvisioner.kt    新增
src/main/kotlin/dev/zcode/ide/runtime/RuntimeUpdater.kt        新增
src/main/kotlin/dev/zcode/ide/runtime/RuntimeLayout.kt         修改
src/main/kotlin/dev/zcode/ide/runtime/NodeProvisioner.kt       修改
src/main/kotlin/dev/zcode/ide/runtime/ServerProcess.kt         修改
src/main/kotlin/dev/zcode/ide/service/ZCodeServerManager.kt    修改
src/main/kotlin/dev/zcode/ide/ui/ZCodePanel.kt                 修改
src/main/kotlin/dev/zcode/ide/settings/ZCodeRuntimeConfigurable.kt 新增

src/main/resources/runtime-manifest.json          新增（baseline）
src/main/resources/runtime-signing-public.pem     新增
src/main/resources/META-INF/plugin.xml            修改

build.gradle.kts                                  修改
scripts/ci-build.mjs                              修改
.github/workflows/build-plugin.yml                修改
```

---

## 附录 B：环境变量总表

| 变量 | 使用者 | 说明 |
|---|---|---|
| `QINIU_ACCESS_KEY` | CI/发布脚本 | 七牛 AK，不入库 |
| `QINIU_SECRET_KEY` | CI/发布脚本 | 七牛 SK，不入库 |
| `QINIU_BUCKET` | CI/发布脚本 | `zcode-ide` 或 `<your-bucket>` |
| `QINIU_DOMAIN` | CI/发布脚本 | `https://cdn.example.com` |
| `QINIU_PREFIX` | CI/发布脚本 | `zcode-ide` |
| `QINIU_UPLOAD_HOST` | CI/发布脚本 | `https://up-z2.qiniup.com` |
| `RUNTIME_SIGNING_KEY` | CI/发布脚本 | Ed25519 私钥 PEM/base64 |
| `ZCODE_DATA_BASE_DIR` | 插件 | 覆盖 `~/.zcode` |
| `ZCODE_IDE_RUNTIME` | 插件 | 本地 runtime 目录 |
| `ZCODE_IDE_RUNTIME_MANIFEST_URL` | 插件 | 覆盖 manifest 地址 |
| `ZCODE_IDE_RUNTIME_BASE_URL` | 插件 | 覆盖 archive 基础地址 |
| `ZCODE_IDE_RUNTIME_CHANNEL` | 插件 | `stable` / `beta` |
| `ZCODE_IDE_RUNTIME_AUTO_UPDATE` | 插件 | `0` 关闭自动检查 |
| `ZCODE_IDE_RUNTIME_ALLOW_HTTP` | 插件 | 设为 `1` 时显式放行 `http://` 运行时源（仅七牛测试域名联调；生产必须 HTTPS，默认关闭） |

---

## 附录 C：七牛上传代码复用说明

直接参考 `E:\work\<your-bucket>\uploader\src\qiniu.ts`：

- `buildUploadToken()`：putPolicy + HMAC-SHA1 + urlsafe base64（保留 `=`）；
- `fetchRegionHosts()`：`uc.qbox.me/v4/query` 区域发现；
- `uploadFile()`：流式 multipart + `Content-Length` + `duplex: 'half'`；
- `regionHostFromError()`：从 `incorrect region` 错误里提取正确上传域名；
- `setMime()`：`chgm` 修正 MIME。

本仓库不要跨仓库 import <your-bucket> 的代码；在 `scripts/publish-runtime.mjs` 内复制最小实现，并保留来源注释。
