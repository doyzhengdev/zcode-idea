# 项目地图（文件级）

> 回答三个问题：这条功能在哪个文件？该改哪一个？哪些不能碰？
> 分层架构与两条通道见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)；硬约束见 [`../development/INVARIANTS.md`](../development/INVARIANTS.md)。
> 本文按 2026-10-25 的实际代码核对；与代码冲突时以代码为准。

## 1. 运行时全景

```
IDE 进程
├── ZCodeToolWindowFactory ──► ZCodePanel（每个项目窗口一个 JBCefBrowser）
│     ├── URL：127.0.0.1:<port>/?token=..&ideWorkspace=<项目>&ideLocale=..&ideTheme=..&ideHost=1
│     ├── injectBridge  → window.__ZCODE_IDE_QUERY__ → JBCefJSQuery → IdeBridge
│     └── executeJavaScript → window.__zcodeIdeMessage → ideContextPush
├── ZCodeIdeService（项目级门面：面板注册 + IDE→Web 消息队列）
└── ZCodeServerManager（应用级单例：全 IDE 共享一个 server）
      └── ServerProcess → node entry-http.js
            └── server 按 workspaceKey 各自 spawn agent（zcode.cjs app-server --stdio）
```

页面里的一次操作只可能走三条路：

| 路径 | 链路 | 是否经过我们的代码 |
|---|---|---|
| 业务 RPC | 页面 → HTTP/WS → `@zcode/server` → agent | 否（官方链路） |
| 本机能力 | 页面 → `__ZCODE_IDE_QUERY__` → `IdeBridge.dispatch` → IDE API | 是（桥） |
| IDE 主动推送 | Action → `ZCodeIdeService` → `ZCodePanel` → `__zcodeIdeMessage` → 页面 | 是（单向推送） |

## 2. 插件层（`src/main/kotlin/dev/zcode/ide/`）

| 文件 | 职责 | 什么时候改 |
|---|---|---|
| `runtime/RuntimeLayout.kt` | runtime 根目录定位（系统属性 → env → vendor/ZCode → 插件自带 → 用户目录下载版，5 级） | 新增部署形态或安装布局 |
| `runtime/RuntimeManifest.kt` | manifest 数据类：baseline 加载、解析（未知字段忽略）、版本比较、兼容检查（schema/api/plugin 区间/sha256/size）、Ed25519 验签 | manifest 字段或兼容契约（`runtimeApiVersion`）变化 |
| `runtime/RuntimeProvisioner.kt` | runtime 按需供给：下载（Range 续传 + 停滞看门狗）、sha256/size 校验、zip-slip 校验解压、文件锁（多 IDE 并发）、current/pending 指针原子写、旧版本清理；文件尾的 `RuntimeSettings` 是设置页/属性/env 优先级链的唯一出处 | 下载、校验、落盘、清理策略 |
| `runtime/RuntimeUpdater.kt` | 远端签名 manifest 检查（24h 节流 + 并发防御）、验签失败回退 baseline、后台下载到版本目录写 pending、通知 | 更新检查与切换策略 |
| `runtime/NodeRuntime.kt` | 查找 Node 24（设置 → 环境变量 → PATH → 常见目录） | 查找顺序变化 |
| `runtime/NodeProvisioner.kt` | 缺 Node 24 时下载、校验、解压到**用户目录** `~/.zcode/ide/runtime-node`（锁定 manifest 的 `nodeVersion`；插件目录旧副本自动迁移） | 镜像、校验、解压策略 |
| `runtime/ServerProcess.kt` | 启停 server、固定端口、token 持久化、健康检查、杀进程树；记录 `runtimeVersion`，残留 server 版本不符时杀子进程/按端口找 PID/换端口 | 进程生命周期、端口、注入的环境变量 |
| `service/ZCodeServerManager.kt` | 应用级单例、共享 server、重启广播；启动前 `RuntimeProvisioner.ensure` + `NodeProvisioner.ensure`，pending 运行时优先启动：成功 promote、失败 rollback | 多窗口行为、重启/重试、runtime 更新接入 |
| `service/ZCodeIdeService.kt` | 项目级门面、面板注册、IDE→Web 消息队列 | 新增 IDE→Web 消息类型 |
| `ui/ZCodePanel.kt` | JCEF 面板、桥注入、主题同步、光标同步（remote-mode 丢失 cursor 回调的补偿）、`Ctrl+W`、reload 重建；runtime 下载进度回显、失败重试、面板就绪触发一次更新检查 | JCEF 宿主交互、runtime 状态展示、指针形状 |
| `ui/ZCodeToolWindowFactory.kt` | ToolWindow 内容装配与空状态兜底 | 窗口注册与重建 |
| `bridge/IdeBridge.kt` | Web→IDE 的 15 个能力（见 §3） | 新增本机能力 |
| `remote/RemoteControlBridge.kt` | 应用级 Web 远控 device 桥：全 IDE 单进程；项目列表来自 server `projectService`（ZCode 里添加的全部项目） | relay 桥生命周期、手机远控 |
| `remote/RemoteControlAutoStart.kt` | IDE 启动后延迟恢复上次远控；用户显式停止才清除意图 | 自动恢复、启用意图持久化 |
| `action/SendToZCodeComposerAction.kt` | 右键把文件引用发到输入框 | 菜单行为 |
| `action/SendSelectionToZCodeComposerAction.kt` | 编辑器选区发送 `路径#Lx-Ly` | 同上 |
| `settings/ZCodeRuntimeConfigurable.kt` | 设置页「ZCode 运行时」：自动更新开关、渠道、manifest URL / 镜像覆盖、当前版本探测、立即检查、清理运行时缓存；env 覆盖只读标注 | 设置项与文案 |
| `startup/RuntimeUpdateCheckActivity.kt` | IDE 启动后延迟 60s 触发一次运行时更新检查（与面板/设置页共用 24h 节流） | 检查触发时机 |
| `startup/PromoteZCodeActionsActivity.kt` | 启动后把两个右键动作置顶 | 与其他插件抢菜单 |

## 3. 桥契约（新增能力必须三处同步）

`packages/web-ide/src/idePlatform.ts` 声明 → `IdeBridge.dispatch` 分支 → 前端调用点。
`dispatch` 的 `else` 必须抛 `unsupported bridge method: <name>`，不要改回静默返回。

| method | 用途 |
|---|---|
| `selectDirectory` / `selectDirectories` | 选目录（单个 / 多个） |
| `selectFile` / `selectFiles` | 选文件（单个 / 多个） |
| `saveFile` | 另存为，字节以 base64 过桥 |
| `createTempTextAttachment` | 把文本落成本机临时附件 |
| `materializeWorkflowArtifactFile` | 工作流产物落成本机文件（base64） |
| `openExternal` | 浏览器打开外部链接 |
| `openInFileManager` | 在系统文件管理器中定位 |
| `openExternalFile` | 在 IDE 编辑器打开（支持 `line` / `column`） |
| `selectInProjectView` | 在 IDE 项目树中定位 |
| `showTaskNotification` | IDE 通知 |
| `startWebRemoteControl` | 启动手机远控 device 桥，返回 `qrUrl`/`sessionId` |
| `stopWebRemoteControl` | 停止远控桥进程 |
| `getWebRemoteControlStatus` | 查询远控桥状态（`idle` / `running`） |

前端统一经 `packages/web-ide/src/ideBridge.ts` 的 `invoke()` 调用；二进制（`ArrayBuffer`/`Uint8Array`）必须先转 base64。

### 3.1 IDE → Web 消息（反向通道）

`ZCodePanel` 用 `executeJavaScript` 调 `window.__zcodeIdeMessage(json)`，由 `web-ide/src/ideContextPush.ts` 分发。新增 op 同样要三处同步：Kotlin 发送点 → `ideContextPush` 分支 → 页面 handler；未知 op 打 WARN，不静默丢弃。

| op | 用途 |
|---|---|
| `filesToInput` | 右键发送文件引用到输入框（`ZCodeIdeService.sendPathsToComposer`） |
| `selectionToInput` | 编辑器选区发送 `完整路径#Lx-Ly`，只发引用不发原文（`sendSelectionToComposer`） |

## 4. IDE 版 Web（`vendor/ZCode/packages/web-ide/`）

| 文件 | 职责 |
|---|---|
| `src/main.tsx` | 解析 URL（`ideWorkspace` 优先于 server-info）、创建 platform、挂载 context push |
| `src/idePlatform.ts` | 实现官方 `IPlatformService`：文件能力 + MCP 用户目录读写 + 远控三方法（转发给 Kotlin 桥） |
| `src/ideBridge.ts` | `invoke()` 封装：发请求、等 `__zcodeIdeResolve` 回填 |
| `src/ideContextPush.ts` | `__zcodeIdeMessage` 的 op 分发（`filesToInput` / `selectionToInput` 等） |
| `src/styles.css` | IDE 形态的纯视觉精简与配色覆盖（只被 IDE 入口加载；含拖拽线 hover 高亮） |

## 5. 官方 UI 的 IDE 适配点（`vendor/ZCode/packages/ui/`）

| 文件 | 作用 | 注意 |
|---|---|---|
| `src/lib/ideHost.ts` | `isIdeHost()`：读 URL 的 `ideHost=1` | 所有 UI 分支的唯一开关 |
| `src/lib/ideFileOpen.ts` | source 类型 → 打开方式（`file`/`patch`/`multi-file-diff`/`text` 进 IDE 编辑器） | 全站唯一规则 |
| `src/hooks/useAppPanels.ts` | `handleOpenCodeViewer` / `handleNavigateFileManager` / `handleOpenFileManager` | 文件打开与目录定位的汇合点，规则只改这里 |
| `src/lib/codeViewerSource.ts` | 内置查看器的 source 类型定义 | 新增类型要同步 `ideFileOpen.ts` |
| `src/SettingsPage.tsx` | 记忆详情入口的 `isIdeHost()` 门控 | 上游写死 `isDesktop`，这是一行例外 |
| `src/app-shell/WorkspaceShellLayout.tsx` | 头部/侧栏渲染条件 | 上游行为，改动前确认不是纯视觉问题 |
| `src/v4/useWorkspaceSessionsIndexItems.ts` | 侧栏 running 图标自愈与重订 | 必须宿主门控 |
| `src/project-sidebar/useProjectTree.ts` | 项目树自愈 effect | 曾缺 `isIdeHost()` 门控 |
| `src/WorkspaceSidebarFooter.tsx` | 侧栏底部远控触发按钮 | 上游只在 `isDesktop` 渲染；IDE 用 `isDesktop \|\| isIdeHost()` 放开 |

## 6. Server / CLI（`vendor/ZCode/`）

| 位置 | 职责 |
|---|---|
| `packages/server/src/entry-http.ts` | HTTP/WS 入口、local 宿主形态、一次性数据修复 |
| `packages/server/src/http.ts` | 路由与 RPC 分发 |
| `packages/server/src/hostCapability.ts` | 宿主能力上报 |
| `packages/server/src/source-server/` | 业务实现（任务表、会话、同步等） |
| `packages/shared/src/` | 身份与路径工具（含 Windows 盘符修复） |
| `packages/ide-remote-bridge/` | **插件自有**：Web 远控 device 桥（复用 desktop relay transport，把手机 RPC 转到本地 `/ws`）。**workspaceKey 必须用 server 原始 `rootPath`**：server 按字面字符串派生 agent，手机端换一种路径写法就会多起一套 |
| `apps/zcode-cli/` | Agent CLI 与 `zcode.cjs` |

这些目录里我们改动的每个文件都要计入补丁预算；完整清单与原因见 [`../upstream/CHANGES-VS-UPSTREAM.md`](../upstream/CHANGES-VS-UPSTREAM.md)。

## 7. 构建链

| 脚本/文件 | 输入 → 输出 |
|---|---|
| `scripts/bootstrap.mjs` | `vendor/zcode.lock` → 准备 `vendor/ZCode` 工作副本 |
| `scripts/build-runtime.mjs` | fork 的构建产物 → `dist/`（web/server/agent/remote-bridge/node_modules/许可 + `BUILD-INFO.json`） |
| `scripts/package-runtime.mjs` | `dist/` → `build/runtime/`：确定性 zip + `manifest.json` + Ed25519 签名（`--write-manifest` 同步写 baseline `src/main/resources/runtime-manifest.json`） |
| `scripts/publish-runtime.mjs` | `build/runtime/` → 七牛（默认 dry-run，`--apply` 才上传；顺序 zip → sig → manifest，版本路径不可变） |
| `scripts/patch-budget.mjs` | git 改动统计 → 与 `patchBudget.maxModified` 比对 |
| `scripts/ci-build.mjs` | CI 单入口：clone/install/build/runtime/打包签名/buildPlugin |
| `build.gradle.kts` | `dist/` → 插件 `runtime/` → `build/distributions/zcode-ide-<ver>.zip`；`-PbundleRuntime=true` 打完整包，默认薄包（`stripRuntimeFromSandbox` 清沙箱残留） |

## 8. 改动边界

| 区域 | 权限 |
|---|---|
| `src/main/kotlin/`、`src/main/resources/` | 自有代码，可直接改 |
| `vendor/ZCode/packages/web-ide/` | 我们新增的 IDE 入口，可直接改 |
| `scripts/` | 自有脚本，可直接改 |
| `vendor/ZCode/packages/ui/` | **必须 `isIdeHost()` 门控**，且优先 CSS 而非 JSX |
| `vendor/ZCode/packages/server/`、`packages/shared/` | 谨慎：涉及数据兼容与桌面端共用，改动计入预算 |
| `vendor/ZCode` 其他官方代码、`gradle/` wrapper、桌面入口 | 不改；确需改动先说明理由并计入预算 |

与桌面客户端的功能差异（哪些支持、哪些不支持、哪里行为不同）见 [`IDE-VS-DESKTOP.md`](./IDE-VS-DESKTOP.md)。
