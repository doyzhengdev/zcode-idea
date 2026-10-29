# 常见任务 → 改动落点

> 按任务定位该改哪个文件，以及取舍准则。
> 动手前先读 [`INVARIANTS.md`](./INVARIANTS.md)；架构背景见 [`ARCHITECTURE.md`](../architecture/ARCHITECTURE.md)。

| 任务 | 改哪里 |
|---|---|
| 插件生命周期、进程管理、端口、Node 查找 | `src/main/kotlin/dev/zcode/ide/runtime/`、`service/` |
| JCEF 面板、主题、快捷键、消息推送 | `src/main/kotlin/dev/zcode/ide/ui/ZCodePanel.kt` |
| 新增 Web→IDE 能力 | `bridge/IdeBridge.kt` 的 `dispatch` + `packages/web-ide/src/idePlatform.ts` |
| 手机 / Web 远控 | Kotlin 启停：`src/main/kotlin/dev/zcode/ide/remote/RemoteControlBridge.kt`（应用级单进程，多窗口共用）；自动恢复：`RemoteControlAutoStart.kt`（IDE 启动后延迟恢复，用户停止才清除意图）；协议桥：`vendor/ZCode/packages/ide-remote-bridge/`（复用 desktop transport + client 分片适配，项目列表读 server `projectService.readTree()`）；入口：`packages/ui/src/WorkspaceSidebarFooter.tsx`（`isDesktop \|\| isIdeHost()`） |
| 工具窗口/菜单/扩展注册 | `src/main/resources/META-INF/plugin.xml` |
| IDE 内嵌形态的 UI 精简/交互 | 先 `vendor/ZCode/packages/web-ide/src/styles.css`（纯视觉/入口隐藏）；CSS 选择器不稳定时才用 `vendor/ZCode/packages/ui/src/...` + `isIdeHost()` 门控。判据与占位检查见 [`IDE-UI-TRIMMING.md`](./IDE-UI-TRIMMING.md) |
| 会话里点文件改用 IDE 编辑器打开 | 只有两个汇合点：`packages/ui/src/hooks/useAppPanels.ts` 的 `handleOpenCodeViewer`（全站唯一内置查看器入口）与 `handleNavigateFileManager`（面板内文件树翻页），二者都调 `packages/ui/src/lib/ideFileOpen.ts`。`file`/`patch`/`multi-file-diff`/`text` 一律进 IDE 编辑器；media/pdf/pptx/image/code-review 仍走内置预览。**不要在各调用点逐一打补丁**（2026-10-24 曾在 5 个组件里散着改，已收回） |
| 目录链接 / 文件树定位改用 IDE 项目树 | `useAppPanels.handleOpenFileManager` + `platform.selectInProjectView`（Kotlin `ProjectView.select`） |
| 编辑器选区发送到输入框 | `src/main/kotlin/dev/zcode/ide/action/SendSelectionToZCodeComposerAction.kt` + `ZCodeIdeService.sendSelectionToComposer` + `web-ide/src/ideContextPush.ts` 的 `selectionToInput`。**只发 `完整路径#Lx-Ly`（GitHub 行锚点），不发选中原文**。菜单入口见下一行 |
| 右键菜单置顶 | `plugin.xml` 的 `anchor="first"` 只能保证在 XML 注册项之前；其他插件（CodeBuddy 等 VSIX 桥接）会在启动后动态插到最前。`startup/PromoteZCodeActionsActivity.kt` 在启动完成与 3 秒后再把两个动作 `remove` + `add(FIRST)` 一次，实测能压过 CodeBuddy；之后再有插件插入仍可能反超 |
| IDE 版 Web 启动、项目绑定、身份 | `vendor\ZCode\packages\web-ide\src\{main.tsx,idePlatform.ts,ideBridge.ts,ideContextPush.ts}` |
| server 任务表/身份/路径修复 | `vendor\ZCode\packages\server\src\`、`packages\shared\src\`、`apps\zcode-cli\` |
| runtime 打包内容 | `scripts/build-runtime.mjs` |
| IDE 宿主能力适配（桌面形态开关、记忆、MCP） | `vendor/ZCode/packages/web-ide/src/{main.tsx,idePlatform.ts,styles.css}`；记忆详情门控在 `packages/ui/src/SettingsPage.tsx`（`isIdeHost()` 一行） |
| 打包配置、平台版本、excludeDirs | `build.gradle.kts`、`settings.gradle.kts`、`gradle.properties` |

## 取舍准则

**功能优先在插件侧实现。** 插件自有代码（Kotlin、`packages/web-ide`、`scripts`）正常写；只有需要改变官方 UI 行为或 server 数据逻辑、插件侧确实做不到时，才进 `vendor/ZCode` 的官方原有文件。真要动官方源码时，按 宿主侧配置 → web-ide CSS → platform 适配 → 官方 UI（`isIdeHost()` 门控）→ 官方 server/shared 的顺序选择，并解释为什么不能放在插件侧。

病灶在官方 UI 的 React 初始化路径或 server 任务表写入逻辑时，必须改 fork 源码（插件侧 `executeJavaScript` 只能注入 DOM，改不了组件初始化，也无法在 server 启动前改 SQLite）；能放进 `ServerProcess.kt` 的就不动源码。**纯视觉隐藏与入口隐藏优先走 web-ide CSS**（`packages/web-ide/src/styles.css`，只被 IDE 入口加载），CSS 选择器是否可用、隐藏后还要检查哪些占位，见 [`IDE-UI-TRIMMING.md`](./IDE-UI-TRIMMING.md)；确实需要改变渲染分支或行为时才用 `isIdeHost()` 门控。新增官方源码补丁前先跑 `node scripts/patch-budget.mjs`，超出 `patchBudget` 时必须先说明为什么 CSS / platform / 运行时注入都不可行。上游更新由我们自行 fetch + rebase 合并回 Work，不提 PR（见 [`ZCODE-UPSTREAM-SYNC.md`](../upstream/ZCODE-UPSTREAM-SYNC.md)）。

## 改动位置准则

行为类改动（点一下之后做什么）先找调用链尽头的唯一函数，改那里；找不到就先把入口收敛出来再加规则。同一个语义在 N 个组件里各写一遍，等于把未来的同步成本放大 N 倍，也会被 review 直接打回。视觉类改动优先 CSS，行为类改动优先单一入口，两者都不要按调用点铺开。
