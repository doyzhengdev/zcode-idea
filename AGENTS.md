# AGENTS.md — AI 入口

> 你是本仓库的开发者。**这一页是唯一入口**：读完再动手，之后只按任务读 1–2 篇文档，不要全量通读。
> 项目本质：JetBrains IDE 插件。JCEF 内嵌官方 ZCode Web UI，Node 侧直接跑官方 `@zcode/server`，不使用 Electron。
> 事实优先级：**代码与构建脚本 > `README.md` > `architecture/HANDOFF.md` > 会话纪要**。文档里的旧路径按[换算表](.agents/docs/README.md#8-文档换算表遇到旧路径时)理解，不要照抄。

## 1. 项目地图

```
IDE 进程
├── ZCodeToolWindowFactory ──► ZCodePanel（JCEF，每窗口一个）
│     ├── URL: 127.0.0.1:<port>/?token=..&ideWorkspace=<项目>&ideHost=1
│     ├── JBCefJSQuery ──► IdeBridge        ← Web 调 IDE（15 个能力）
│     └── executeJavaScript ──► __zcodeIdeMessage → ideContextPush   （IDE 推 Web）
├── ZCodeIdeService（项目级门面、消息队列）
├── RemoteControlBridge（应用级）──► node remote-bridge/index.mjs
│     └── 官方 relay device 桥：手机 /remote/v4 ↔ relay ↔ 本地 server /ws
└── ZCodeServerManager（应用级单例）
      └── ServerProcess → node entry-http.js（全 IDE 一个）
            └── 按 workspaceKey 各自 spawn agent（zcode.cjs app-server --stdio）
```

必须建立的心智模型：

- **两个仓库**：本仓库（插件壳）+ `vendor/ZCode`（官方 fork，独立 git，被忽略，版本锁在 `vendor/zcode.lock`）。
- **页面里的普通业务请求不经过我们的代码**：UI ↔ server 走同源 HTTP/WS。只有"本机能力"才过桥。
- **全 IDE 只有一个 server**：端口固定、所有窗口同 origin（localStorage 才不会丢）；项目路径靠 URL 的 `ideWorkspace` 传入。
- **两份前端可能不同步**：开发期 runtime 优先取源码 `vendor/ZCode` 的 dist，不是安装目录。以日志 `web=` 判断这次验证的是哪份。

细节地图（文件级职责、桥方法、改动边界）：[`architecture/PROJECT-MAP.md`](.agents/docs/architecture/PROJECT-MAP.md)。

## 2. 开发方式：功能优先在插件侧实现

这个仓库首先是**我们自己的 IDE 插件**，不是官方客户端的分支。

- **插件自有代码正常写**：`src/main/kotlin/`、`src/main/resources/`、`packages/web-ide/`、`scripts/` 都是我们的代码。新增功能、重构、调整结构都可以，按正常工程标准来，不存在"改多了"的问题。
- **能插件侧实现就插件侧实现**：新增能力优先做成插件能力（Kotlin + 桥 + platform），不要为了省事去改官方组件。
- **只有插件侧确实做不到时才进官方源码**，典型场景：官方 UI 的 React 初始化/状态逻辑、server 的任务表写入与数据迁移、必须在 server 启动前生效的行为。

改官方源码时才适用下面的约束：

- **每个官方原有文件的补丁都要能回答"为什么插件侧做不到"**，并写进提交信息或回复；答不出来就不该改在这里。
- 跑 `node scripts/patch-budget.mjs`：官方源码**修改**文件数不得超过 `patchBudget.maxModified`（当前 23）。`packages/web-ide/`、`pnpm-lock.yaml` 与官方文件里的纯新增文件不计入。
- **对官方文件不顺手重构、不整体格式化、不改无关行**——官方 diff 的每一行都是未来 rebase 的成本。
- 纯视觉隐藏优先 web-ide CSS；官方 UI 的行为分叉必须 `isIdeHost()` 门控。
- **同步上游或增删官方补丁后，必须更新 [`upstream/CHANGES-VS-UPSTREAM.md`](.agents/docs/upstream/CHANGES-VS-UPSTREAM.md)**：§0 数字、§3 逐文件、§8 追加同步记录。

## 3. 任务路由

| 任务 | 先读 | 主要落点 |
|---|---|---|
| 进程、端口、Node、生命周期 | [INVARIANTS](.agents/docs/development/INVARIANTS.md) | `src/main/kotlin/.../runtime/`、`service/` |
| 新增 Web→IDE 能力 | [PROJECT-MAP §3](.agents/docs/architecture/PROJECT-MAP.md) | `bridge/IdeBridge.kt` + `web-ide/src/idePlatform.ts` + 前端调用点 |
| JCEF、主题、快捷键、消息推送 | [PROJECT-MAP §2](.agents/docs/architecture/PROJECT-MAP.md) | `ui/ZCodePanel.kt`、`service/ZCodeIdeService.kt` |
| IDE 内 UI 精简 / 交互 | [WORK-MAP](.agents/docs/development/WORK-MAP.md) | `packages/ui/`，**必须 `isIdeHost()` 门控** |
| 点文件 / 目录定位 | [WORK-MAP](.agents/docs/development/WORK-MAP.md) | `useAppPanels.ts` 三个汇合点 + `lib/ideFileOpen.ts` |
| 手机 / Web 远控 | [WORK-MAP](.agents/docs/development/WORK-MAP.md)、[变更记录](.agents/docs/changes/2026-10-25-ide-web-remote-control.md) | `remote/RemoteControlBridge.kt` + `vendor/ZCode/packages/ide-remote-bridge/` + `web-ide/src/idePlatform.ts` |
| server 数据 / 身份 / 路径 | [CHANGES-VS-UPSTREAM](.agents/docs/upstream/CHANGES-VS-UPSTREAM.md) | `packages/server/`、`packages/shared/`（计入预算） |
| 构建、部署、发版 | [BUILD-AND-DEPLOY](.agents/docs/build/BUILD-AND-DEPLOY.md) | `scripts/`、`build.gradle.kts` |
| runtime 下载 / 更新 / 设置页（已实施） | [RUNTIME-DISTRIBUTION](.agents/docs/build/RUNTIME-DISTRIBUTION.md) + [PROJECT-MAP §2](.agents/docs/architecture/PROJECT-MAP.md) | `runtime/RuntimeManifest|Provisioner|Updater.kt` + `settings/ZCodeRuntimeConfigurable.kt` + `scripts/package-runtime.mjs` |
| 同步上游 | [ZCODE-UPSTREAM-SYNC](.agents/docs/upstream/ZCODE-UPSTREAM-SYNC.md) | `vendor/ZCode`（在 fork 目录内提交） |
| 实机排查 | [ENVIRONMENT](.agents/docs/development/ENVIRONMENT.md) | 日志前缀 `[zcode-server]`、CDP |

## 4. 红线（不可协商）

1. **尽量不改官方源码——这是底线原则，优先级高于任何需求**：本仓库首先是插件壳，官方源码（`vendor/ZCode`）只在插件侧确实做不到时才动，且必须逐文件回答"为什么插件侧做不到"。功能与官方补丁面冲突时，宁可调整功能方案（换官方既有通道、降级交互）也不新增官方补丁；改官方文件必须说明理由并守住补丁预算。插件自有代码（`src/main/kotlin/`、`packages/web-ide/`、`scripts/`）不受限。
2. **UI 改动必须 `isIdeHost()` 门控**：桌面端与独立 web 端行为必须不变。
3. **一种用户动作只有一个判定点**：不要跟着调用点铺补丁。
4. **桥三处同步**：`idePlatform.ts` 声明、`IdeBridge.dispatch` 分支、前端调用点；未知方法必须抛错，二进制先转 base64。
5. **端口全 IDE 固定一个**：不要按工作区/窗口分配；否则 localStorage 全丢。
6. **不改 `rootProject.name`，ToolWindow id 固定 `ZCodeIDE`**：否则覆盖 ZC GUI 插件或冲突。
7. **不伪装桌面**：`isDesktop` 保持 `false`；窗口控件、托盘、通知、更新由 IDE 承担。
8. **不把 `vendor/ZCode` 下的文件加进本仓库**：它有自己的 `.git`；本仓库只用 `vendor/zcode.lock` 记录 commit。
9. **`scripts/*.cjs` 默认 dry-run**：它们会写 `~/.zcode`，执行 `--apply` 前必须关闭桌面客户端和插件 server。
10. **"功能回归"先证伪产物**：比 hash → 看 CDP 实际加载的 bundle → 看时间戳 → 最后才读代码。
11. **每次修改源码必须写变更记录**：在 [`.agents/docs/changes/`](.agents/docs/changes/) 新增一篇（模板见其 README），提交前跑 `node scripts/check-change-log.mjs`。**没有记录 = 改动未完成**；涉及官方源码补丁时还要更新 [`CHANGES-VS-UPSTREAM.md`](.agents/docs/upstream/CHANGES-VS-UPSTREAM.md)。

## 5. 完成标准

**编译通过不等于完成。** 一次交付必须走完：

1. 前端/官方源码改动：先在 `vendor/ZCode` 里 `pnpm --filter <pkg> build`；
2. `node scripts/build-runtime.mjs` 重新组装 `dist/`（顺序不能颠倒，`buildPlugin` 不编译前端）；需要同步 baseline 或发布 runtime 时，接着跑 `node scripts/package-runtime.mjs`（`buildPlugin` 默认薄包约 3.8MB，`-PbundleRuntime=true` 才打完整包）；
3. `./gradlew buildPlugin`（必须 JDK 21）；
4. 部署到本机 IDE（见 [deploy skill](.agents/skills/deploy-zcode-plugin/SKILL.md)）；
5. 用日志 `web=` 或 CDP 验证真实行为，并说明验证到哪一步；
6. 在 [`.agents/docs/changes/`](.agents/docs/changes/) 新增变更记录（模板见其 README）；涉及官方源码补丁时同时更新 [`CHANGES-VS-UPSTREAM.md`](.agents/docs/upstream/CHANGES-VS-UPSTREAM.md)；
7. 汇报时给出：改了什么、为什么必须改在这里、验证结果、剩余风险。
8. 改动涉及文档描述（构建、桥、补丁面、任务落点、已知缺口）时，同步更新对应文档；约定见 [`README.md`](.agents/docs/README.md#9-文档维护约定)。

没验证就写"未验证"，不要用"应该可以"结案。

## 6. 文档

| 文档 | 用途 |
|---|---|
| [`architecture/PROJECT-MAP.md`](.agents/docs/architecture/PROJECT-MAP.md) | 文件级地图：职责、桥契约、改动边界 |
| [`architecture/ARCHITECTURE.md`](.agents/docs/architecture/ARCHITECTURE.md) | 分层架构、两个仓库、两条通道 |
| [`architecture/IDE-VS-DESKTOP.md`](.agents/docs/architecture/IDE-VS-DESKTOP.md) | 插件 vs 桌面客户端：支持什么、不支持什么、哪里行为不同 |
| [`architecture/HANDOFF.md`](.agents/docs/architecture/HANDOFF.md) | 主技术文档与实现细节（最全，按需查） |
| [`development/INVARIANTS.md`](.agents/docs/development/INVARIANTS.md) | 24 条不变量与踩坑，改代码前必读 |
| [`development/WORK-MAP.md`](.agents/docs/development/WORK-MAP.md) | 任务 → 落点、取舍准则 |
| [`development/ENVIRONMENT.md`](.agents/docs/development/ENVIRONMENT.md) | 工具链、日志、CDP 观测 |
| [`development/STATUS.md`](.agents/docs/development/STATUS.md) | 当前进度与待办 |
| [`changes/README.md`](.agents/docs/changes/README.md) | 变更记录规范、模板与索引；**每次改源码必须新增一篇** |
| [`build/BUILD-AND-DEPLOY.md`](.agents/docs/build/BUILD-AND-DEPLOY.md) | 构建与部署 |
| [`upstream/CHANGES-VS-UPSTREAM.md`](.agents/docs/upstream/CHANGES-VS-UPSTREAM.md) | 相对上游的逐文件改动清单与补丁预算；**每次同步必须更新** |
| [`README.md`](.agents/docs/README.md) | 全部文档索引 |

其他入口：[`README.md`](./README.md)（给人看）、[`vendor/README.md`](./vendor/README.md)（fork 工作副本）、[`.github/workflows/build-plugin.yml`](./.github/workflows/build-plugin.yml)（CI）。
