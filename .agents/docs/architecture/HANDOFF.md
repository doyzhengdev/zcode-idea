# ZCode IDE 插件开发交接文档

> 更新时间：2026-10-23
> 目标：在 JetBrains IDE 内嵌**官方 ZCode Web UI**，后端跑官方 Node server，完全不用 Electron。
>
> **2026-10-24 迁移注记**：本仓库已从 `E:\work\zcode-ide` 迁移到 `E:\work\doyzheng\zcode-ide`（origin 本就指向 github.com/doyzhengdev/zcode-idea）。官方源码 fork 已移入 `E:\work\doyzheng\zcode-ide\vendor\ZCode`（独立 git 仓库，被 `.gitignore` 忽略；`E:\work\ZCode`、`E:\work\ZCode` 均为废弃旧位置）。下文如有 `E:/github/zcode-ide`、`E:/work/ZCode` 形式的旧路径，一律按新位置理解。
>
> **当前文档导航（2026-10-25）**：本文件保留完整实现细节与历史决策；快速定位改动落点用 [`PROJECT-MAP.md`](./PROJECT-MAP.md)，架构总览用 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，文档索引见 [`../README.md`](../README.md)。

---

## 1. 项目目标与边界

- **UI 完全复用官方源码**：`@zcode/ui` 组件库（与桌面版同一套代码），不使用桌面安装包里的 `app.asar`。
- **后端完全复用官方源码**：`@zcode/server`（HTTP + WebSocket），由 Node 24 运行。
- **只替换两样东西**：
  1. Electron 的窗口容器 → JCEF（IDE 内置浏览器）
  2. Electron 的 preload 桥（`window.zcode`）→ `JBCefJSQuery` + 自定义 `IPlatformService`
- 不做：远程工作区、Docker/WSL、Computer Use、内置浏览器 side pane（首期）；**Web 远控已支持**（`packages/ide-remote-bridge` device 桥）。

---

## 2. 架构

```
IntelliJ 2025.1+ (JDK 21)
├── ToolWindow / JBCefBrowser
│     └── http://127.0.0.1:<port>/?token=<token>&ideLocale=<zh-CN|en-US>
│           └── packages/web-ide/dist
│                 ├── 官方 Root（@zcode/ui）
│                 ├── createIdePlatform()（IPlatformService 的 IDE 实现）
│                 └── WS /ws → @zcode/server（Node 24）
│                       └── spawn agent/zcode.cjs app-server --stdio
└── JBCefJSQuery ←→ IdeBridge（文件对话框、打开文件、通知）
```

### 两条通道

| 通道 | 用途 | 实现 |
|---|---|---|
| 浏览器网络 | UI ↔ server 的 HTTP + WebSocket RPC | 同源 `127.0.0.1:<port>`，`?token=` 换 Cookie |
| JBCefJSQuery | UI ↔ IDE 能力（文件对话框等） | JS 调 `window.__ZCODE_IDE_QUERY__(json)`，Java 回 `__zcodeIdeResolve(id, ok, payload)` |

> JCEF 就是 Chromium，`fetch`/WebSocket 都能正常用；它不能做的是访问 IDE API 和本地文件系统，所以需要第二条通道。

---

## 3. 目录布局

```
E:/work/
├── zcode-ide/                       # 【插件工程】Gradle + Kotlin（扁平单模块）
│   ├── vendor/ZCode/                # 【官方源码 fork】独立 git 仓库（gitignore，重建见 vendor/README.md）
│   │   └── packages/web-ide/        # IDE 版 Web 应用（我们新增）
│   │       ├── package.json
│   │       ├── vite.config.ts
│   │       ├── index.html
│   │       └── src/
│   │           ├── main.tsx         # 入口：连接 server、项目绑定、locale
│   │           ├── idePlatform.ts   # IPlatformService 的 IDE 实现
│   │           ├── ideBridge.ts     # JCEF 桥 + 浏览器 dev 兜底
│   │           └── styles.css
│   ├── src/main/
│   │   ├── kotlin/dev/zcode/ide/
│   │   │   ├── runtime/RuntimeLayout.kt
│   │   │   ├── runtime/NodeRuntime.kt
│   │   │   ├── runtime/ServerProcess.kt
│   │   │   ├── service/ZCodeIdeService.kt
│   │   │   ├── ui/ZCodePanel.kt
│   │   │   ├── ui/ZCodeToolWindowFactory.kt
│   │   │   └── bridge/IdeBridge.kt
│   │   └── resources/META-INF/plugin.xml
│   ├── build.gradle.kts             # 根 = 模块（rootProject.name = zcode-ide = 安装后的 plugins/zcode-ide）
│   ├── scripts/build-runtime.mjs    # 组装 dist/
│   ├── dist/                        # 运行时组装产物（gitignore，194MB；安装态目录名为 runtime/）
│   └── README.md
├── (参考仓库在 E:/github/)
│   ├── zcode-jetbrains-plugin/      # 【参考骨架】csuftt 的插件（不要修改）
│   └── zcode-asar/                  # 桌面端 app.asar 解包（仅分析用）
```

---

## 4. 关键实现说明

### 4.1 运行时定位（`RuntimeLayout.kt`）

按顺序：

1. `-Dzcode.ide.runtime=<dir>`
2. 环境变量 `ZCODE_IDE_RUNTIME`
3. `<user.dir>/vendor/ZCode`（开发期 fork 工作副本）
4. `PluginManagerCore.getPlugin("dev.zcode.ide")?.pluginPath/runtime`（安装态）
5. `<plugins>/zcode-ide/runtime`（兼容手动放置）

支持两种布局：

- **仓库布局**：`packages/server/dist/entry-http.js` + `packages/web-ide/dist` + `apps/zcode-cli/packages/cli/dist/zcode.cjs`
- **打包布局**：`server/entry-http.js` + `web/` + `agent/zcode.cjs`

### 4.2 Node 查找（`NodeRuntime.kt`）

- 顺序：`zcode.ide.nodePath` → `ZCODE_IDE_NODE` → PATH → 常见目录（含 scoop/nvm）
- 优先 **24.x**，其次 25/26，最后任意版本（低于 24 会给出明确错误）
- 本机 Node 24 路径：`C:/Users/<user>/scoop/persist/nvm/nodejs/v24.14.0/node.exe`

### 4.3 server 启动（`ServerProcess.kt`）

每个项目一个 server 进程：

```
PORT=<随机空闲端口>
ZCODE_SERVER_HOST=127.0.0.1
ZCODE_SERVER_AUTH_TOKEN=<32 字节 base64url>
ZCODE_WEB_STATIC_ROOT=<runtime>/web
ZCODE_SERVER_WORKSPACE=<IDE 项目根路径>
ZCODE_AGENT_SERVER_COMMAND=<node>
ZCODE_AGENT_SERVER_ARGS_JSON=["<runtime>/agent/zcode.cjs","app-server","--stdio"]
```

启动后轮询 `/api/server-info`（Bearer token），60s 超时；退出时 Windows 用 `taskkill /T /F` 杀进程树。

### 4.4 项目与分组绑定（web-ide `main.tsx`）

这是踩坑最多的地方：

1. **Web 模式必须有项目记录**：独立 server 的 `ownerHostId` 是 `remote:server:<serverId>`，不是 `local`；没有 projectId 时发消息会报 `project.remote-project-required`。
2. **官方新建项目对话框在 Web 模式是坏的**：它固定传 `hostId: "local"`，报 `project.host-offline`。我们绕过它：
   - 启动时读 `projectService.readTree()`
   - 若当前工作区没有项目，直接 `saveProject({ name, roots: [path] })`（**不传 hostId**，服务端会自动补正确 host）
   - 然后 `startDraft(canonicalPath, undefined, identity, { projectId })` 绑定草稿
3. **路径必须严格一致**：服务端 `project.roots[0].rootPath` 是规范化后的反斜杠路径，而 `/api/server-info` 返回的是斜杠路径；发送时是严格字符串比较，所以要用项目根路径（`canonicalPath`）渲染 Root。
4. **workspaceIdentity 必须传**：UI 用 `remoteHostIdFromWorkspaceIdentity(identity)` 推导 hostId；不传会落到 `local`，导致分组操作 `task-group.host-identity-mismatch`。我们用 `buildServerRemoteWorkspaceIdentity({ serverId, workspacePath })` 构造。

### 4.5 语言

- 插件加载 URL 时附加 `&ideLocale=zh-CN|en-US`（取 `Locale.getDefault()`）
- web-ide 传给 `ZCodeIntlProvider` 的 `initialLocale` 和 `resolveSystemLocale`
- 原因：`setting.json` 的 `localePreference` 常是 `system`，而 JCEF 的 `navigator.language` 是 `en-US`

### 4.6 文件/图片选择

- `canSelectFilePath: true` → UI 调 `platform.selectFiles()` → 桥打开 IDE 文件选择框 → 返回绝对路径 → 零上传直接发给 Agent
- 桥的处理器必须放到后台线程（`executeOnPooledThread`），且 `invokeAndWait` 前判断是否已在 EDT，否则会抛 `Cannot call invokeAndWait from the event dispatch thread`

### 4.7 主题同步

- 打开 URL 时附加 `&ideTheme=dark|light`（取自 `JBColor.isBright()`）。
- `web-ide/index.html` 的内联脚本优先读取 `ideTheme`，在 `@zcode/ui` 的 store 求值前写入 `zcode-theme`，避免首屏闪回本地偏好。
- 面板通过 `messageBus.connect(panel).subscribe(LafManagerListener.TOPIC, ...)` 监听 LAF 变化，注入 JS 同步 `dark` / `theme-zai-*` class、`data-zcode-browser-theme-surface` 与 `colorScheme`。
- 注意 2025.1 已废弃 `LafManager.addLafManagerListener(listener)` 单参数版本，也没有双参数重载，必须走 MessageBus。

### 4.8 工具窗口内容生命周期

- `plugin.xml` 里 `canCloseContents="false"`，内容本身也设为 `isCloseable = false`。
- Factory 额外挂 `ContentManagerListener`：内容被意外清空时在 EDT 上补回一个 `ZCodePanel`，避免 ToolWindow 退化成平台空状态。
- **Ctrl+W 必须单独拦**：即使内容不可关闭，IDE 的“关闭内容”动作仍会把唯一内容移除。实测该按键在 CEF 层（`CefKeyboardHandler.onPreKeyEvent`）和 Swing 层（`KeyEventDispatcher`、组件 `InputMap`）都收不到——它在更上层就被 keymap 消费掉了。可行方案是给浏览器组件注册组件级快捷键，优先级高于全局 keymap：

  ```kotlin
  swallowCtrlW.registerCustomShortcutSet(
      CustomShortcutSet(KeyStroke.getKeyStroke("control W")),
      cefBrowser.component,
      this,
  )
  ```

  其中 `swallowCtrlW` 是一个空的 `AnAction`。`ContentManagerListener` 只作为兜底，不能替代这一步。

### 4.9 远程 attachment 注册（“设备未连接”的根因）

现象：面板能加载、界面完整，但连接图标显示“未连接”，输入框提示“设备未连接，暂时无法发送”。

根因链条：

1. `buildServerRemoteWorkspaceIdentity()` 给出的 `workspaceIdentity` 让官方 UI 把工作区判定为 **remote**（`remote:server:<serverId>`）。
2. 判定为 remote 后，`resolveWorkspaceServices()` 要求该 remote 目标能解析到 `useRemoteWorkspaceSessionStore.sessionsById` 里的 session，否则返回空，`rpcReady` 恒为 false。
3. 官方桌面/Web 流程由 `RemoteWorkspaceController` 建立连接后注册 attachment；IDE 版是直连本地 server，没有任何代码走那条路，于是 session 永远缺失。

修复（`packages/web-ide/src/main.tsx`，在绑定项目之后执行）：

```tsx
const sessionId = `ide-local:${workspaceIdentity}`;
registerBaseWorkspaceServices(services);
registerRemoteWorkspaceSession({ sessionId, workspacePath, workspaceIdentity, services });
useRemoteWorkspaceSessionStore.getState().bindWorkspaceIdentity(workspaceIdentity, sessionId);
bindRemoteWorkspacePath(workspacePath, sessionId);
```

注意 `bindRemoteWorkspaceIdentity` **没有**从 `@zcode/ui` 导出（构建会报 `MISSING_EXPORT`），必须用 store 上的 `bindWorkspaceIdentity`。

### 4.10 端口固定（会话草稿/模型偏好跨重启保留）

JCEF 的 `localStorage` 按 **origin**（`scheme://host:port`）隔离。原来 `freePort()` 每次启动都取随机端口，等于每次重启都换一份全新的存储：草稿、最近使用的模型、侧栏宽度、界面偏好全部丢失。症状就是"切了模型，重启 IDE 又回默认"。

修复（`ServerProcess.choosePort()`）：

- 以工作区路径的 SHA-256 前 8 字节生成 key，端口存进 `PropertiesComponent`（`zcode.ide.port.<hash>`），下次启动优先复用；
- 端口被占用时回退到随机端口并覆盖记录；
- 日志会出现 `Reusing ZCode server port <port> for <workspace>`。

实测：`jcef_cache/Default/Local Storage/leveldb` 里曾累积了 21 个不同 origin；固定端口后重启复用同一 origin，输入框里留下的草稿在重启后原样恢复。

**注意上游语义**：草稿只在正文非空时持久化（`composerDraftStore`：`mode/modelSelection` 随正文一起保存）；"最近模型"在提交被接受时才写入。所以只切模型、不输入也不发送，重启后仍会回默认——这是官方行为，不是插件的 bug。

### 4.11 旧任务行的工作区身份补全

**现象**：点历史会话时右侧完全不变化，日志里连一条 RPC 都没有。

**原因**：早期插件版本写入的任务行 `host_id` 已经是 `remote:server:<id>`，但 `workspace_key` / `workspace_identity` 还是裸路径。UI 用 `buildTaskWorkspaceKey(path, identity)` 区分 scope：`activateTabByPath` 按路径命中已有 tab，`setActiveTaskId` 却写到路径 scope，而 SessionPane 读的是 identity scope，于是既不加载也不报错。

**修复**：server 启动时（`packages/server/src/entry-http.ts`）把当前工作区下这些行补成规范身份，SQL 是幂等的：

```sql
UPDATE tasks SET workspace_key = ?, workspace_identity = ?
 WHERE host_id = ? AND workspace_path = ?
   AND (workspace_identity IS NULL OR trim(workspace_identity) = '')
```

身份用 `buildServerRemoteWorkspaceIdentity({ serverId, workspacePath })` 生成（例如 `remote:server:<host>:/E:/github/zcode-ide`）。**只在插件注入 `ZCODE_SERVER_WORKSPACE` 时执行**，桌面端不受影响。成功时 server 日志打印 `normalized N legacy task row(s)`。

> 这是数据修复，只处理历史上由旧版插件写坏的行；新版插件创建的任务本来就带 identity。

### 4.12 「新增对话」不沿用最近模型（草稿 scope 丢身份）

**现象**：在某个会话里切过模型，点分组右侧的「新增对话」，新会话仍然显示默认模型（GLM-5.3）。

**根因链**（在运行时用 localStorage 打点确认）：

1. 项目行的「+」调用 `onCreateTask({ projectId, taskGroupId })`，Root 用 `"projectId" in request` 判断“显式项目”，于是跳过从活动工作区继承 `hostId` 的分支；
2. `prepareSession({ projectId })` 只返回路径，不带 `workspaceIdentity`；
3. 草稿 scope 由 `resolveComposerScope(draftProjectId, workspaceIdentity, ...)` 生成，identity 为空时 `hostId` 退化成 `"local"`；
4. 最近模型写在 `zcode-composer-recent:v2:["desktop","remote:server:<host>","<projectId>"]`，读的却是 `["desktop","local","<projectId>"]`，读不到就回落到服务端默认模型。

**修复**（四处）：

- `project-sidebar/index.tsx`：没有项目归属时**不要**传 `projectId: null`，否则会被当成显式项目；
- `root/useRootWorkspaceActions.ts`：同一窗口、同一路径时沿用活动工作区的 identity，补上 `prepareSession` 丢失的身份；
- `lib/composerRecent.ts`：写入时额外保存一份 workspace 级副本，读取时精确 key 缺失则回退到它；
- `v4/composer/useDraftConfigControl.ts`：空正文的「新建任务」每次进入按 Recent 重新播种一次。之前只在草稿没有 `mode` 时初始化，残留的空草稿会把模型永久钉在旧值上。用 `scopeKey` 做闸门，同一次进入内不会反复覆盖用户当次的改选。

**验证**：点「+」后 composer 显示的是上次使用的 `od/deepseek-v4.1-flash`；启动态的调试打点显示 `identity=remote:server:<host>:/E:/github/zcode-ide`、`recentRaw` 命中。

### 4.13 主题还原（调试用）

`options/laf.xml` 里 `<laf themeId="..."/>` 用的是主题 provider id，不是界面上的显示名。IDEA 2026.2 中对应关系（见 `intellij.platform.ide.impl.jar` 的 `META-INF`）：

| 界面显示 | themeId |
|---|---|
| Islands Dark | `Islands Dark` |
| Islands Light | `Islands Light` |
| Islands Darcula | `Islands Darcula` |
| Light（expUI） | `ExperimentalLight` |
| Dark（expUI） | `ExperimentalDark` |

调试切换主题后要还原，直接改这个文件（IDE 必须已退出，否则退出时会被内存状态覆盖）。

### 4.14 IDE 模式的界面精简（`ideHost=1`）

插件加载 webview 时在 URL 上追加 `ideHost=1`（`ZCodePanel.createBrowser`），UI 侧 `packages/ui/src/lib/ideHost.ts` 的 `isIdeHost()` 读这个参数，**只影响 IDE 内嵌形态，桌面端与独立 web 端不变**：

- 侧栏顶部导航的「新建任务」「自动化」「插件市场」三个入口全部隐藏（官方组件保持原状，`web-ide/src/styles.css` 按 `data-testid` 隐藏；新建入口改由头部右上角 ➕ 承担）。
- 侧栏顶部 48px 拖拽条缩为 8px（没有桌面浮层，不需要留白）。
- 任务列表头部的搜索 / 视图切换两个按钮由 `web-ide/src/styles.css` 按 `data-testid` 隐藏（官方组件保持原状）。
- 中间区域不再渲染项目区 / 分组视图 / 置顶区，只渲染**当前项目**的任务、按最近活动排序（`project-sidebar/index.tsx` 的 `ideHost` 分支：按 `workspacePath` 归一化匹配项目 `roots`，过滤 `task.projectId === ideProject.id`）。未归属项目的散会话不显示。
- 头部右上角隐藏帮助 / 终端 / 右侧面板三个按钮，只留一个「➕ 新建对话」（`WorkspaceHeaderActionSection.tsx`）；点击 = 新建会话 + 若侧栏收起则展开。
- 整个顶部浮层在 IDE 隐藏（`web-ide/src/styles.css`）：前进/后退、侧栏开关、新建对话、更新在工具窗口里都不适用；`DesktopTopOverlay.tsx` 已还原为上游原状。
- 浮层隐藏后，侧栏收起时 header 内层 / Side Pane tab 栏原本用于避让的 `pl-38`/`pl-44` 由同一份 CSS 清零，避免会话标题左侧出现空白。
- 侧栏右缘中点固定一个折叠把手（`WorkspaceShellLayout.tsx`，`data-testid="ide-sidebar-toggle"`），`left = max(0px, calc(var(--workspace-sidebar-panel-width) - 11px))`，收起后停在左边缘可再展开。

### 4.15 新建任务在 IDE 报 `project.remote-navigation-unavailable`（已修）

现象：点侧栏「新建任务」或右上角「➕」没有任何反应（无 toast、无 RPC 后续）。定位方式：临时在 `useRootWorkspaceActions.ts` 里塞 toast（`workspaceActionError` 只 set 不渲染，catch 是静默的）。

根因：`startNewTaskFromActiveWorkspace` 从活动附件身份推导出 `hostId = remote:server:<id>`（非 local），进入远程导航分支后要求 `prepareSession` 返回 `workspaceIdentity`；但本插件场景 `prepareSession` 只回路径，且 web-ide 没有 `openRemoteProjectWorkspace`，于是直接 throw。

修复（`useRootWorkspaceActions.ts`）：

```ts
const targetIdentity = target.workspaceIdentity ??
  (activeWorkspacePath && sameWorkspacePath(activeWorkspacePath, target.workspacePath)
    ? (activeWorkspaceIdentity?.trim() || undefined) : undefined);
// 已经挂在同一个远端附件上：hostId 只是从附件身份推导出来的，不需要再做远程导航。
const alreadyAttached = Boolean(targetIdentity) && targetIdentity === activeWorkspaceIdentity?.trim();
```

`alreadyAttached` 时跳过 `openRemoteProjectWorkspace`，直接 `addTab` + `startDraftInWorkspace`。`sameWorkspacePath` 做反斜杠/大小写/尾斜杠归一化（Windows 上 prepareSession 与活动 tab 的路径写法可能不一致，`===` 会漏判）。

注意：该头部只在 `activeTaskId !== null || isDesktop` 时渲染（`WorkspaceShellLayout` 的 `shouldRenderWorkspaceHeader`），所以欢迎页（无活动任务）右上角没有 ➕——这是上游行为，此时侧栏本身就在且「新建任务」在侧栏顶部。

### 4.16 会话文件点击 → IDE 编辑器（ideHost）

点击会话里的文件（改动摘要行、工具结果里的文件引用、消息内 markdown 文件链接等）最终都汇到两个入口，都在 `isIdeHost()` 时拦截并转成 `platform.openExternalFile(path)`（插件 `IdeBridge.openExternalFile` → `FileEditorManager.openFile`）：

- `App.tsx` 的 `handleOpenCodeViewerIfWritable`：改动摘要行、预览卡等直接走 `onOpenCodeViewer` 的入口。
- `WorkspaceShellLayout.handleOpenMarkdownFileLink`（消息/工具行里的文件链接，`onOpenFileLink`）：stat 为文件后同样落到上面的 Code Viewer 入口。

**路径必须是干净的绝对路径**：消息里的链接常是 `./a/b` 或含 `..` 的相对路径，直接拼给 IDE 会解析失败且原本是静默的。`App.tsx` 的 `normalizeIdeFilePath` 按段消解 `.`/`..`；Kotlin 侧再用 `File(path).canonicalFile` 兜底，VFS 找不到文件时弹通知而不是无声失败。解析不出路径的来源（纯文本、匿名 diff）仍走内置预览。

### 4.17 IDE → Web 推送与右键发送文件引用

**通道**（Java → JS 方向，与 4.4 的 JS → Java 查询通道相对）：

- `ZCodePanel.pushToWebview(json)`：`executeJavaScript("window.__zcodeIdeMessage(<json>)")`，页面加载完成前排队（`pendingPushes`），`onLoadEnd` 冲刷；面板在 `createBrowser` 注册进 `ZCodeIdeService.panel`，`dispose` 时释放。
- `ZCodeIdeService.sendPathsToComposer(files)`：show 工具窗口后推送；面板尚未创建时消息暂存在服务的 `queuedWebviewMessage`，面板注册时取走。
- Web 侧 `packages/web-ide/src/ideContextPush.ts` 安装 `window.__zcodeIdeMessage`，消费 `{op:"filesToInput", refs:[{path, kind}]}`。

**右键菜单**（参考 `E:\work\zcode-jetbrains-plugin` 的 `SendFileToInputAction`）：

- `SendToZCodeComposerAction` 注册在 `ProjectViewPopupMenu`（first）、`EditorTabPopupMenu`（first）、`EditorPopupMenu`（last）；取 `VIRTUAL_FILE_ARRAY`（缺数组时兜底单数 `VIRTUAL_FILE`），支持多选。
- Web 侧把每个路径构造为官方 `WorkspaceFileDragPayload`，派发官方「加入对话」事件（`zcode:add-workspace-file-to-chat`，workspace 文件树右键/拖拽同链路）：composer 聚焦时消费，引用 chip **追加到输入框末尾**（自动分隔空格）；事件未被消费（面板未聚焦）时回退 store 请求（官方既有 `prepend-if-missing`，插到开头）兜底，不丢消息。工作区外的路径用绝对路径做引用。官方源码零改动（2026-10-28 起；此前曾用 store 请求 `prepend-if-missing` 导致引用固定插到第一段开头）。
- `SessionPane` 的 `externalTextInsertRequest` 原本只在草稿态（`sessionId === null`）消费，已放开为 `focused` 即可——桌面端既有调用只在草稿态触发，不受影响。

---

## 5. 构建与安装

### 5.1 构建官方运行时

```bash
cd E:/work/doyzheng/zcode-ide/vendor/ZCode
export PATH="/c/Users/<user>/scoop/persist/nvm/nodejs/v24.14.0:$PATH"

pnpm install
pnpm --filter "@zcode/tui..." build      # TUI 依赖闭包（避免 build:zcode 的 staging 报错）
pnpm --filter @zcode/server build
pnpm --filter @zcode/web build
pnpm --filter @zcode/web-ide build       # 我们的 IDE 版前端
```

> `pnpm build:zcode` 的 TUI 资产阶段依赖 `@zcode/shared` 的 dist，而上游该包没有 build 脚本，会失败；Web 模式不需要 TUI，用上面的分步构建。

### 5.2 组装运行时 + 打包插件

```bash
cd E:/github/zcode-ide
node scripts/build-runtime.mjs           # 生成 dist/（约 194MB）
export JAVA_HOME="$USERPROFILE/.jdks/jdk-21.0.12.1+1"
./gradlew buildPlugin
# 产物：build/distributions/zcode-ide-0.1.0.zip（约 49MB）
```

`build-runtime.mjs` 会：

- 拷 `packages/web-ide/dist` → `dist/web`
- 拷 `packages/server/dist` → `dist/server`
- 拷 `zcode.cjs` + `provider` → `dist/agent`
- 调官方 `copyRuntimeNodeModules()` 拷依赖闭包
- 调 `patchNodePtyPrebuilds()`
- 拷 `LICENSE` / `NOTICE.md` / `THIRD-PARTY-NOTICES.md`
- 删除所有 `.map`

`buildPlugin` 会通过 `copyRuntimeToSandbox` 把 `dist/` 放进插件根目录一起打包（安装态目录名为 `runtime/`）。

**顺序不能颠倒**：只要改过 `packages/web-ide` 的源码，就必须先 `pnpm --filter @zcode/web-ide build`，再 `node scripts/build-runtime.mjs`，最后 `buildPlugin`。只重跑 `buildPlugin` 会把旧的 `dist/web` 打进 zip（Gradle 不会自己编译前端）。校验办法：

```bash
unzip -l build/distributions/zcode-ide-0.1.0.zip | grep web/assets/index-
# 文件名里的 hash 应与 vendor/ZCode/packages/web-ide/dist/assets/index-*.js 一致
```

### 5.3 安装

1. Settings → Plugins → 卸载旧的 "ZCode IDE"
2. Install Plugin from Disk → `zcode-ide-0.1.0.zip`
3. 重启 IDE
4. 右侧 "ZCode IDE" 工具窗口

**注意**：包根目录必须是 `zcode-ide/`（`rootProject.name`）。之前用 `intellij-plugin/` 会把参考插件 ZC GUI 的目录整个覆盖。

### 5.4 快速部署（替换文件 + 重启，不走 Install from Disk）

日常迭代不需要每次都从 Settings 装一遍。IntelliJ 的自定义插件就是 `plugins/` 下的一个目录，启动时扫描，所以直接替换文件、重启即可生效：

```bash
PLUGINS="$APPDATA/JetBrains/IntelliJIdea2026.2/plugins"

# 1) IDE 必须已完全退出（运行中 jar 被锁，且 JVM 不会热重载类）
#    优先 Alt+F4 / File → Exit，让它写回配置
powershell -NoProfile -Command "while (Get-Process idea64 -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }"

# 2) 整个目录删掉再解压，避免残留旧 hash 的前端 bundle 和旧 jar
rm -rf "$PLUGINS/zcode-ide"
unzip -q build/distributions/zcode-ide-0.1.0.zip -d "$PLUGINS"

# 3) 重启（等 30–45s 再验证）
powershell -NoProfile -Command "Start-Process -FilePath 'C:\Program Files\JetBrains\IntelliJ IDEA 2026.2.2\bin\idea64.exe' -ArgumentList 'E:\work\zcode-ide' -WorkingDirectory 'E:\work\zcode-ide'"
```

要点：

- `system/plugins/zcode-ide.zip` 是 Install from Disk 留下的缓存，**启动不读**，不用同步更新。
- 版本号保持 `0.1.0` 不影响加载，只是没有"可更新"提示。
- 改过前端时，必须按 5.2 的顺序先 `web-ide build` → `build-runtime.mjs` → `buildPlugin`，否则 zip 里是旧 bundle。
- 替换后看日志确认 runtime 来源：`grep -a "Starting ZCode server" <idea.log> | tail -1`，`web=` 应指向 `plugins\zcode-ide\runtime\web`；若指向 `E:\work\zcode-ide\ZCode\packages\web-ide\dist`，说明 `RuntimeLayout` 选了仓库布局，打包的 runtime 并没有被验证。

完整的步骤、校验命令与排错表已做成项目级 skill：`.agents/skills/deploy-zcode-plugin/SKILL.md`。下次打包后可以直接说"部署到 IDE"。

---

## 6. 已验证功能

- [x] 官方 server 在纯 Node 24 下运行（无 Electron）
- [x] 官方 Web UI 在浏览器/JCEF 中渲染
- [x] 登录态复用（读取 `~/.zcode`）
- [x] 项目列表、会话列表
- [x] 发送消息，Agent 正常回复并流式输出
- [x] 自动创建/绑定项目与草稿
- [x] 分组 host identity 修复
- [x] 主题跟随 IDE 明暗切换（深色 → 浅色 → 深色双向切换，冷启动首次加载也是当前主题）
- [x] 工具窗口按 `Ctrl+W` 不消失（用 CustomShortcutSet 覆盖，见 4.8）
- [x] 工具窗口关闭后可从 View → Tool Windows 重新打开，内容正常（见 7.1）
- [x] 远程 attachment 修复后连接状态正常，输入框可用（见 4.9）
- [x] 冷启动后发消息，Agent 正常回复
- [x] 端口跨重启复用（日志 `Reusing ZCode server port`），输入框草稿重启后保留
- [x] 早期版本写坏的历史任务点开正常显示内容（启动日志 `normalized 14 legacy task row(s)`）
- [x] 点分组「+」新增对话沿用上次选择的模型（草稿 scope 保持 remote 身份）
- [x] 完整包离线启动（解压后直接跑 `runtime/server/entry-http.js` 验证通过）
- [x] IDE 精简侧栏（自动化/插件市场/搜索/视图切换/前进后退箭头隐藏，只显示当前项目最近对话，见 4.14）
- [x] 侧栏右缘中点折叠把手：收起/展开双向可用，收起后停在左缘
- [x] 头部右上角 ➕：新建会话并展开已收起的侧栏（见 4.15）
- [x] 侧栏「新建任务」在远程附件下正常进入草稿态（`alreadyAttached` 修复）
- [x] 项目树/编辑器 Tab/编辑器右键「发送到 ZCode 对话框」：文件走官方「加入对话」事件（chip 末尾追加），选区走官方「代码评论加入对话」事件（上下文附件，不覆盖草稿）；均官方既有事件、零补丁（2026-10-28/29，SessionPane 补丁已还原）
- [x] 点击会话中的文件（改动摘要行）直接在 IDE 编辑器打开（见 4.16）

---

## 7. 已知问题

### 7.1 会话全部关闭后显示“没有要显示的内容”（已修，已实机验证）

- **现象**：在 ZCode UI 里关闭所有会话后，工具窗口变成 IDE 自带的空状态文案“没有要显示的内容”。
- **原因**：ToolWindow 的内容被 IDE 的关闭内容动作移除（JCEF 未吞掉 `Ctrl+W`），而 `canCloseContents="true"` 让这个动作可用；内容移除后没有任何逻辑重新添加。
- **修复**：
  1. `plugin.xml` 改为 `canCloseContents="false"`，内容设为 `isCloseable = false`；
  2. 组件级 `CustomShortcutSet` 吞掉 `Ctrl+W`（详见 4.8）；
  3. Factory 挂 `ContentManagerListener` 兜底，内容数量归零时在 EDT 上重建 `ZCodePanel`。
- **实机结果**：焦点在 JCEF 内按 `Ctrl+W` 面板保持打开；从 View → Tool Windows 关闭再打开也正常。

### 7.2 `runIde` 任务失败（上游 bug，未修）

- 报错：`Index: 1, Size: 1`
- 根因：IntelliJ Platform Gradle Plugin **2.1.0** 的 `ProductInfoKt.resolveIdeHomeVariable` 假设每个 JVM 参数都含 `=`，而 IDEA 2025.1 的 `product-info.json` 第一个参数是 `-Xbootclasspath/a:...`。
- 影响：只能用 zip 安装测试，不能用 `./gradlew runIde`。
- 可选绕过：升级 Gradle 插件到修复版本（当前阿里云镜像只有 2.1.0，`plugins.gradle.org` DNS 不通）；或从 SDK 手动启动沙箱 IDE。

### 7.3 Node 运行时由插件自己保证

- 系统已有 Node 24.x 时直接用，不下载。
- 没有 24.x 时，`NodeProvisioner` 从淘宝镜像（`https://registry.npmmirror.com/-/binary/node`，
  失败回落 `nodejs.org`）取最新 v24，下载对应平台压缩包、用 `SHASUMS256.txt` 校验 SHA256，
  解压到 `<plugin>/runtime-node/v24.x.y/`，再交给 server 与 agent 使用。
- 下载在后台线程执行，面板显示"正在下载 Node … x/y MB"；失败会显示错误并提供重试按钮。
- 不引入 `ezn`：Java 侧直接实现下载/校验/解压，省掉 ezn 自身需要 Node ≥16 的鸡生蛋问题。
- 插件升级会整目录替换，`runtime-node` 随之删除并在下次启动时重新下载。

### 7.4 官方"新建项目"对话框在 Web 模式不可用

- 已通过启动时 `saveProject` 绕过；对话框本身仍会报 `project.host-offline`。
- 后续可在 web-ide 里替换该入口。

### 7.5 数据目录共享

- 默认共享 `~/.zcode`（登录态、会话、任务索引）。
- 不要与桌面版同时运行，避免 SQLite 锁冲突。
- 调试隔离：`ZCODE_DATA_BASE_DIR` + `ZCODE_DESKTOP_HOME_DIR`。

### 7.6 无关弹窗

- "支持 依赖项 'javascript:npm:astro' 的插件 Astro 未安装"：IntelliJ 对项目 `package.json` 的插件建议，与本插件无关。

---

## 8. 待办（按优先级）

1. **M3 IDE 集成（剩余）**
   - 多标签/多项目策略
2. **M4 体积优化**
   - 裁剪 server node_modules（终端/SSH/Docker 可选）
   - web dist 目前 49MB（mermaid/pdfjs/office 预览占大头）
4. **提交代码**
   - `vendor/ZCode` 的 `ide-integration` 分支：web-ide 与全部补丁已于 2026-10-24 提交（`eded5be9`、`f2f72b14` 两个提交尚未推送 Work）
   - `E:/github/zcode-ide`：插件源码（`ZCodePanel.kt`、`ZCodeToolWindowFactory.kt`、`plugin.xml`、README、docs）尚未提交

---

## 9. 调试入口

| 内容 | 位置 |
|---|---|
| IDE 日志（含 server 转发） | `C:/Users/<user>/AppData/Local/JetBrains/IntelliJIdea2026.2/log/idea.log` |
| 已安装插件 | `C:/Users/<user>/AppData/Roaming/JetBrains/IntelliJIdea2026.2/plugins/zcode-ide` |
| server 日志前缀 | `[zcode-server]`，Logger 名 `ZCodeIDE` |
| 前端错误 | 见 `web-ide/main.tsx` 的 `renderFatal`；浏览器 dev 模式看控制台 |

常用排查：

```bash
grep -a "zcode-server" ".../log/idea.log" | tail -50
grep -a "FAIL\|Error" ".../log/idea.log" | tail -30
```

---

## 10. 关键决策记录

| 决策 | 原因 |
|---|---|
| 不用 `app.asar`，从源码构建 | 桌面 renderer 依赖 122 个 preload 方法；源码 Apache-2.0 可编译可改 |
| `web-ide` 放在官方仓库 | 必须 `workspace:*` 引用 `@zcode/ui` / `@zcode/client` |
| server 每项目一个进程 | 隔离状态、避免多项目互相干扰；代价是多进程 |
| 共享 `~/.zcode` | 登录态与会话与桌面版一致；代价是并发风险 |
| 包根目录 `zcode-ide` | 避免覆盖参考插件 `intellij-plugin/` |
| JCEF 直连本地 HTTP server | 同源，无 CORS/混合内容问题；比自定义传输层简单可靠 |

---

## 11. 环境与网络

| 项 | 值 |
|---|---|
| JDK（构建） | `C:/Users/<user>/.jdks/jdk-21.0.12.1+1` |
| Node（运行/构建） | `C:/Users/<user>/scoop/persist/nvm/nodejs/v24.14.0` |
| pnpm | 10.33.2（corepack shim 已启用） |
| Gradle | 8.13（wrapper） |
| IntelliJ SDK | 2025.1（`idea:ideaIC`） |
| 插件兼容范围 | since 251，until 263.* |

网络注意：

- GitHub 直连 git 不通，用 `https://ghfast.top/https://github.com/...`
- 官方仓库 `.npmrc` 钉死 `registry.npmjs.org`，安装时需覆盖：
  `pnpm install --registry=https://registry.npmmirror.com`
- `plugins.gradle.org` DNS 不通，插件依赖走阿里云 gradle-plugin 镜像
- JetBrains SDK 走 `cache-redirector.jetbrains.com`

---

## 12. 一次完整复现流程

```bash
# 1. 官方运行时
cd E:/work/doyzheng/zcode-ide/vendor/ZCode
export PATH="/c/Users/<user>/scoop/persist/nvm/nodejs/v24.14.0:$PATH"
pnpm install --registry=https://registry.npmmirror.com
pnpm --filter "@zcode/tui..." build
pnpm --filter @zcode/server build
pnpm --filter @zcode/web-ide build

# 2. 组装运行时（dist/）
cd E:/github/zcode-ide
node scripts/build-runtime.mjs

# 3. 打包插件
export JAVA_HOME="$USERPROFILE/.jdks/jdk-21.0.12.1+1"
./gradlew buildPlugin

# 4. 安装
# Settings → Plugins → Install Plugin from Disk
# build/distributions/zcode-ide-0.1.0.zip
```
