# 2026-10-25 · 薄插件 + ZCode/Node 运行时分发（下载 / 更新 / 回滚 / 设置页 / CI）

- **范围**：插件 Kotlin（runtime/ service/ ui/ settings/ startup/ remote/）、资源（baseline manifest + 公钥 + plugin.xml）、scripts（package/publish/ci-build）、build.gradle.kts、CI workflow、文档、测试
- **触发**：用户需求——插件 zip 51MB 随包发布 runtime，更新插件必须重下 51MB；改为薄插件（约 3.8MB）+ runtime 独立发版（七牛，按需下载/更新/回滚）
- **提交**：working tree（尚未 commit；Task A–G 逐任务实现，简报与报告见 `.superpowers/sdd/RUNTIME-DISTRIBUTION/`）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/package-runtime.mjs` | 新增 | `dist/` → 确定性 zip（yazl，排序/固定 mtime）+ `manifest.json` + Ed25519 签名；`--write-manifest` 写 baseline，`--require-sign` 缺私钥即失败 |
| `scripts/publish-runtime.mjs` | 新增 | `build/runtime/` → 七牛上传（默认 dry-run，`--apply` 才上传；顺序 zip → sig → manifest；同 key 不同 sha256 拒绝；上传前用仓库公钥复验签名） |
| `src/main/kotlin/dev/zcode/ide/runtime/RuntimeManifest.kt` | 新增 | manifest 数据类：baseline 加载、解析（`ignoreUnknownKeys`）、`isNewerThan`、`isCompatible`（schema/api/plugin 区间/sha256/size）、Ed25519 验签 |
| `src/main/kotlin/dev/zcode/ide/runtime/RuntimeProvisioner.kt` | 新增 | 按需供给：Range 续传下载 + 60s 停滞看门狗、sha256/size 校验、zip-slip 校验解压、`FileChannel` 锁（跨进程/同 JVM 重入）、`current/pending` 指针原子写（临时文件 + `ATOMIC_MOVE`，失败退化替换写）、旧版本与过期 `.part` 清理；文件尾 `RuntimeSettings` 为属性/env/设置页优先级链唯一出处 |
| `src/main/kotlin/dev/zcode/ide/runtime/RuntimeUpdater.kt` | 新增 | 远端签名 manifest 检查（24h 节流 + 并发防御 + https 强制）、验签失败回退 baseline、后台下载到版本目录写 `pending.json`、通知 |
| `src/main/kotlin/dev/zcode/ide/runtime/RuntimeLayout.kt` | 修改 | 候选加第 5 级：用户目录 `~/.zcode/ide/runtime/current.json`（下载版）；`runtimeVersion` 从 BUILD-INFO/指针推导，供 server 复用判定 |
| `src/main/kotlin/dev/zcode/ide/runtime/NodeProvisioner.kt` | 修改 | 安装根改用户目录 `~/.zcode/ide/runtime-node`；锁定 baseline `nodeVersion` 不追最新；插件目录旧副本自动迁移 |
| `src/main/kotlin/dev/zcode/ide/runtime/ServerProcess.kt` | 修改 | 记录并持久化 `runtimeVersion`；残留 server 版本不符时：杀自己子进程 → 按端口找 PID 结束（netstat/taskkill、lsof/kill）→ 找不到换端口 |
| `src/main/kotlin/dev/zcode/ide/service/ZCodeServerManager.kt` | 修改 | 启动前 `RuntimeProvisioner.ensure` + `NodeProvisioner.ensure`；pending 运行时优先启动：成功 promote + 清理，失败 rollback 继续 current |
| `src/main/kotlin/dev/zcode/ide/ui/ZCodePanel.kt` | 修改 | runtime 下载进度/失败重试状态回显；面板就绪触发一次更新检查（与启动检查共用节流） |
| `src/main/kotlin/dev/zcode/ide/settings/ZCodeRuntimeConfigurable.kt` | 新增 | 设置页「ZCode 运行时」：自动更新开关、渠道 stable/beta、manifest URL / 镜像 Base URL 覆盖、当前版本（插件/运行时/Node）、立即检查、清理运行时缓存、env 覆盖只读标注 |
| `src/main/kotlin/dev/zcode/ide/startup/RuntimeUpdateCheckActivity.kt` | 新增 | IDE 启动后延迟 60s 触发一次更新检查（pooled thread，异常吞掉打 warn） |
| `src/main/kotlin/dev/zcode/ide/remote/RemoteControlBridge.kt` | 修改 | 适配 runtime 布局接口变化（远控桥的入口路径取自 `RuntimeLayout`） |
| `src/main/resources/runtime-manifest.json` / `runtime-signing-public.pem` | 新增 | baseline manifest（当前 `0.1.0+cf345dcb7d0a`）与 Ed25519 公钥 |
| `src/main/resources/META-INF/plugin.xml` | 修改 | 注册设置页 `dev.zcode.ide.runtime` 与 `RuntimeUpdateCheckActivity`；通知组复用 `ZCodeIDE` |
| `build.gradle.kts` | 修改 | `-PbundleRuntime` 薄/全开关（默认薄包）；新增 `stripRuntimeFromSandbox`（薄包清沙箱残留 runtime/）；intellij-platform 插件 2.1.0 → 2.2.1（修复 `./gradlew test` 开箱崩溃；2.18+ 需 Gradle 9 而 wrapper 8.13） |
| `scripts/ci-build.mjs` / `.github/workflows/build-plugin.yml` | 修改 | CI 在 build-runtime 后插入打包/签名/发布段（开关 `CI_PUBLISH_RUNTIME` / workflow_dispatch `publishRuntime`）；`zcode-runtime-package` artifact |
| `package.json` / `package-lock.json` | 新增 | `yazl`（确定性 zip）依赖，仅打包脚本用 |
| 测试 `src/test/`（10 套件） | 新增 | 124 用例：manifest 解析/兼容/验签、provisioner 下载/校验/zip-slip/锁/指针/清理、updater 节流/验签回退/pending、ServerProcess 版本判定、layout 候选顺序、Node 迁移/锁定、设置链、设置页纯函数 |
| 文档 | 修改 | RUNTIME-DISTRIBUTION.md（状态 → 已实施 + §14 落地记录）、BUILD-AND-DEPLOY.md、PROJECT-MAP.md、AGENTS.md、`.agents/docs/README.md`、INVARIANTS.md（#2/#10/#11 更新 + 新增 #24）、顶层 README.md |

## 为什么改

插件更新携带着 51MB 的 runtime：改一行 Kotlin 用户也要重下 51MB；runtime（fork 前端/server）与插件版本被焊死，无法独立发版。方案（[`RUNTIME-DISTRIBUTION.md`](../build/RUNTIME-DISTRIBUTION.md)）把插件瘦身到约 3.8MB，runtime 改为七牛按 manifest 分发：首次打开面板下载、后台检查更新、下次启动 server 时切换、失败回滚。发布侧 zip 确定性打包 + Ed25519 签名 + sha256/size 校验，运行侧只信 `.complete.json` 完整目录。

## 行为变化

- `./gradlew buildPlugin` 默认产出薄包（约 3.8MB，zip 内 0 个 `runtime/` 条目）；`-PbundleRuntime=true` 才打约 51MB 完整包（离线/内网）。
- 首次打开 ZCode 面板且无任何本地 runtime 时，自动按 baseline manifest 下载（约 44MB）并启动；断点续传、hash 校验、多 IDE 并发单下载者。
- runtime 有新版本时后台下载并通知，下次 server 启动生效；启动失败自动回滚 current。旧残留 server 因 runtime 版本变化被自动结束/换端口。
- 设置出现「ZCode 运行时」页；`ZCODE_IDE_RUNTIME*` 环境变量覆盖设置页。
- Node 24 副本改放 `~/.zcode/ide/runtime-node`（不再随插件目录被更新整目录删除）。
- 桌面端/独立 web 端不受影响（本方案全部是插件侧新增）。

## 验证

- `./gradlew test`（JDK 21）：**125/125 全绿**（0 failures / 0 errors / 0 skipped；收尾新增 Windows 风格 zip-slip 条目拒绝、指针原子写覆盖与无临时文件残留、`PLUGIN_VERSION` ↔ `gradle.properties` 一致性护栏）。
- `./gradlew buildPlugin` 薄包：`zcode-ide-0.1.0.zip` 3,826,135 字节，`zcode-ide/runtime/` 条目 0。
- `./gradlew buildPlugin -PbundleRuntime=true` 完整包：51,188,360 字节，`zcode-ide/runtime/` 条目 5891；随后恢复薄包构建（`Stripped stale runtime` 日志，zip 回到 3,826,135 字节、0 条目）。
- `./gradlew verifyPluginProjectConfiguration`：BUILD SUCCESSFUL。
- hash/签名链（只读）：`build/runtime/manifest.json` 用仓库公钥验签通过；对应 zip 的 sha256/size 与 manifest 一致；baseline（cf345dcb）与其旧 zip 同样核对一致。`publish-runtime.mjs` dry-run 因 build/runtime 下两版 zip 并存按设计拒绝（exit=1，fail-fast 行为本身得到验证）。
- `node scripts/patch-budget.mjs`：官方源码修改 23 / 预算 23，exit 0；**本方案零触碰 `vendor/ZCode`，CHANGES-VS-UPSTREAM 无需更新**。
- 实机矩阵（下载/更新/回滚/双 IDE 并发/离线/设置页/通知等）未在真实 IDE 验证，清单见 `.superpowers/sdd/RUNTIME-DISTRIBUTION/task-G-report.md`。

## 风险 / 后续

- CDN 仍是占位域名 `https://cdn.example.com`：正式 bucket/CDN 未建、CI Secrets 未配；测试环境已完成一次真实上传（见下节），上线前仍需自有备案 HTTPS 域名（§3.2）。
- baseline manifest 已与 dist/锁对齐（`0.1.0+b177da31c187`，由监督者在最终统一验证时重跑 `package-runtime.mjs --write-manifest --require-sign` 产出）。
- 签名私钥在 `~/.zcode/keys/`（CI 用 Secret `RUNTIME_SIGNING_KEY`）：丢失后已发布插件无法再签新 manifest，轮换方案见方案 §11.4。
- 实机未验项：真实下载/更新/回滚链路、双 IDE 并发、Marketplace 安装、macOS spawn-helper。
- `atomicWriteJson` 的 `ATOMIC_MOVE → REPLACE_EXISTING` 退化分支无法在单测触发（无注入缝隙，不改产品代码），已按可观测契约（覆盖写生效、无 `.tmp-` 残留）覆盖并在报告中记为已知缺口。

## 测试环境联调记录（2026-10-26）

- 变更：`scripts/publish-runtime.mjs` 新增显式 `--allow-http` 开关。原因：七牛测试域名只支持 HTTP，原脚本硬性要求 `QINIU_DOMAIN` 为 `https://`，无法联调；开关必须显式给出（绝不默认放行），日志打印「仅限联调；生产必须使用 https:// 自有域名」警告，生产路径行为不变。
- 上传：复用 <your-bucket> 账号，`QINIU_BUCKET=<your-bucket>` + `QINIU_PREFIX=zcode-ide` 隔离，域名 `http://tnbe4cmeo.hn-bkt.clouddn.com`（七牛测试域名，30 天回收、10GB/日回源限制）。凭证从 `E:\work\<your-bucket>\server\.env` 临时导入，未入库、未打印。
- 结果：`--apply` 成功上传 3 个对象（zip 47,240,349 字节 / 7.8s，sig 88 字节，manifest 537 字节）：
  - `zcode-ide/runtime/stable/0.1.0-b177da31c187/zcode-runtime.zip`
  - `zcode-ide/runtime/stable/manifest.sig`
  - `zcode-ide/runtime/stable/manifest.json`
- 端到端校验：HEAD 三对象 200；manifest 下载 sha256 与本地一致（`002fb690…`）；zip 全量下载 sha256 与 manifest 一致（`cc8b326b…`）；远端 manifest 用入库公钥验签 `SIG_VERIFY=true`。`manifest.sig` 的远端 Content-Type 被七牛按扩展名识别为 `application/pgp-signature`（不影响 JVM 按字节读取，未做 chgm）。
- 限制：测试域名为 HTTP，插件运行期强制 HTTPS，**不能直接作为插件下载源**；正式联调/发布需绑定自有 HTTPS 域名（对象键不变，换域名即可）。
- 追加（同日）：运行期新增**显式**调试开关 `ZCODE_IDE_RUNTIME_ALLOW_HTTP=1`（或系统属性 `zcode.ide.runtime.allowHttp`）——`RuntimeSettings.isAllowedSourceUrl` 统一判定，`RuntimeProvisioner.downloadUrl` 与 `RuntimeUpdater.fetchRemote` 共用；默认关闭、不读设置页、首次放行 IDE 日志告警一次，生产 HTTPS 行为不变。新增 5 个单测（协议放行/拒绝、真值解析、无 platform 时告警兜底、Updater 放行分支），`./gradlew test` **130/130 全绿**。
- 本地联调用法（安装态薄包，重启 IDE 后生效）：`ZCODE_IDE_RUNTIME_ALLOW_HTTP=1` + `ZCODE_IDE_RUNTIME_BASE_URL=http://tnbe4cmeo.hn-bkt.clouddn.com`；如需更新检查同时设 `ZCODE_IDE_RUNTIME_MANIFEST_URL=http://tnbe4cmeo.hn-bkt.clouddn.com/zcode-ide/runtime/test/manifest.json`。

## 更新链路联调（2026-10-26，0.1.1）

- 新增 `package-runtime.mjs --runtime-version <v>` 调试参数：直接指定 runtimeVersion（如 `0.1.1+b177da31c187`），**仅用于造一个「更新版本」验证 updater/pending/promote/rollback**；正式发布仍按 `<pluginVersion>+<commit12>` 自动生成。本次因此未改 `gradle.properties`/baseline（否则旧插件会被 `minPluginVersion` 拦成 INCOMPATIBLE）。
- 0.1.1 包内容有真实差异：`dist/BUILD-INFO.json` 的 `pluginVersion` 改为 `0.1.1` 后重新打包（zip sha256 `177e95f8…`，与 0.1.0 的 `cc8b326b…` 不同）。
- `publish-runtime.mjs` 改进：上传时给 zip 设 `Cache-Control: public, max-age=31536000, immutable`、manifest/sig 设 `no-cache`；上传后调用七牛刷新接口。**实测结论（重要）**：测试域名的 CDN 默认对 manifest 缓存一年、`?t=` 查询参数不生效（缓存键不含 query）、表单 `Cache-Control` 未写入对象元数据、刷新 API 返回 401（该 AK 无 CDN 管理权限）——因此测试环境改用**全新 channel 路径** `zcode-ide/runtime/test/` 规避历史缓存。**正式发布必须在七牛控制台为 manifest/sig 配置不缓存（或 1 分钟）规则，并在每次发布后刷新 CDN**，否则客户端最长一年看不到新版本。
- 测试环境已发布：`test` channel 的 `0.1.1+b177da31c187`（zip 47,240,349B、sha256 `177e95f8…`、manifest 兼容 `minPluginVersion=0.1.0`、验签通过）；`stable` channel 保持 `0.1.0` 供首次安装。
- 联调方式：插件 `ZCODE_IDE_RUNTIME_MANIFEST_URL` 指向 `…/runtime/test/manifest.json`，在设置页点「立即检查」（绕过 24h 节流）→ 应收到「运行时更新已下载」通知 → 点「重启 ZCode」→ `current.json` 变为 `0.1.1+b177da31c187`。

## 相关

- 方案与实施落地记录：[`../build/RUNTIME-DISTRIBUTION.md`](../build/RUNTIME-DISTRIBUTION.md)（§14 偏差表）
- 逐任务简报/报告/评审：`.superpowers/sdd/RUNTIME-DISTRIBUTION/`（task-A…task-G）
- 不变量：[`../development/INVARIANTS.md`](../development/INVARIANTS.md) 第 24 条
