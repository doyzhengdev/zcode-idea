# 会话总结（2026-10-23）

> 本文档记录这次会话的完整脉络：需求如何演变、做了哪些验证、写了哪些代码、遇到并修了哪些 bug。
> **路径注记（2026-10-25）**：`docs/` 已迁至 `.agents/docs/` 并按类型分目录，文中 `docs/HANDOFF.md` 等旧路径按 `.agents/docs/<分类>/` 换算；当前结构见 [`../README.md`](../README.md)。
> 技术细节与构建命令见 [`../architecture/HANDOFF.md`](../architecture/HANDOFF.md)。

---

## 1. 需求演进

| 阶段 | 用户诉求 | 结论 / 动作 |
|---|---|---|
| 1 | 把 `csuftt/zcode-jetbrains-plugin` fork 到本地做二次开发 | 直连 GitHub 不通，走 `ghfast.top` 镜像克隆到 `E:/github/zcode-ide`；安装 JDK 17、Node 依赖，跑通协议层测试与 webview 构建 |
| 2 | 分析桌面端 `app.asar` 能否解包 | 能。写了无依赖 asar 解析器，解包到 `E:/github/zcode-asar`（27,773 文件 / 324MB）。修正过一次 11 字节的数据段偏移 bug |
| 3 | 能否用 JCEF 渲染 `app.asar` 的 UI，自带 Node 运行时 | 实测：renderer 能在纯 Chromium 启动，但依赖 `window.zcode` 的 122 个 preload 方法，卡在启动门；不建议移植 |
| 4 | 「不是二次开发，只想完整复用 ZCode UI 和底层」 | 查 GitHub 发现官方 `zai-org/ZCode`（Apache-2.0）已开源完整源码，含 `packages/web`、`packages/server`、`packages/ui`、`apps/zcode-cli`。改用「官方 Web UI + 官方 Node server + JCEF」路线 |
| 5 | 整理目录：插件放 `zcode-ide`，参考项目与官方源码放 `E:/github` | 完成：`zcode-jetbrains-plugin/`、`ZCode/`、`zcode-ide/`、`zcode-asar/` 四个目录 |
| 6 | 问 JCEF 里 UI 怎么发请求 | 澄清：JCEF 就是 Chromium，可以正常 `fetch`/WebSocket；受限的只是 IDE API/文件系统，那部分走 `JBCefJSQuery` |
| 7 | 问 UI 是复用 asar 还是源码重打 | 源码重打。`packages/web-ide` 引用官方 `@zcode/ui`，asar 完全没参与 |
| 8 | 问发布都发哪些文件 | 解释插件 zip 结构、runtime 内容、许可文件、不发布项 |
| 9 | 安装后顶掉了 ZC GUI | 根因：两个插件包根目录都叫 `intellij-plugin/`，安装时整个目录被覆盖。已把模块改名为 `zcode-ide/` |
| 10 | 图片上传失败 | 根因：桥处理器在 EDT 上调 `invokeAndWait` 抛异常。改为后台线程 + EDT 判断 |
| 11 | 语言默认英文 | 根因：`localePreference=system` 时 Web 端取 `navigator.language`。插件注入 `ideLocale`，web-ide 传给 `ZCodeIntlProvider` |
| 12 | 打包完整插件 | 新增 `scripts/build-runtime.mjs`，把 server/web/agent/依赖/许可装进 `runtime/`，Gradle 打包进 zip（49MB） |
| 13 | 发送消息失败 | 起初是 `project.remote-project-required`（Web 模式必须有项目）；随后是 `project.cwd-not-in-roots`（路径格式不一致）；再是 `task-group.host-identity-mismatch`（未传 workspaceIdentity） |
| 14 | 会话全部关闭后显示「没有要显示的内容」 | 判断为 IntelliJ 工具窗口空状态：Content 被关闭/移除后未重建。已记录修复建议，尚未实施 |

---

## 2. 关键技术结论

### 2.1 为什么不用 `app.asar`

- 桌面 renderer 依赖 Electron preload 的 `window.zcode`（122 个方法、184 处 `ipcRenderer`）
- 要跑起来必须写 Electron shim，且内部契约随版本变化
- asar 是专有分发产物；官方源码是 Apache-2.0，可编译可改

### 2.2 官方三端结构

| 包 | 作用 |
|---|---|
| `packages/web` | 官方浏览器 UI |
| `packages/web-ide` | **我们新增**：官方 `@zcode/ui` + IDE 版 platform service |
| `packages/server` | Node HTTP + WS 后端（`entry-http.js`） |
| `packages/ui` | 桌面/Web 共用的 React 组件库 |
| `apps/zcode-cli` | Agent CLI / `zcode.cjs` |

### 2.3 两条通道

- **网络**：JCEF 页面 ↔ `127.0.0.1:<port>` 的 HTTP + WebSocket（同源、`?token=` 换 Cookie）
- **桥**：`JBCefJSQuery` ↔ `IdeBridge`，用于文件对话框、打开文件、通知等 IDE 能力

---

## 3. 交付物

### 3.1 插件工程 `E:/github/zcode-ide`

```
settings.gradle.kts / build.gradle.kts / gradle.properties / gradlew
zcode-ide/                              # 模块（包根目录名）
  build.gradle.kts
  src/main/kotlin/dev/zcode/ide/
    runtime/RuntimeLayout.kt            # runtime 定位（仓库/打包布局）
    runtime/NodeRuntime.kt              # Node 查找，优先 24.x
    runtime/ServerProcess.kt            # 启 server、端口/token/健康检查/杀进程树
    service/ZCodeIdeService.kt          # 项目级生命周期
    ui/ZCodePanel.kt                    # JCEF + 桥注入 + ideLocale
    ui/ZCodeToolWindowFactory.kt
    bridge/IdeBridge.kt                 # 文件对话框/打开文件/通知
  src/main/resources/META-INF/plugin.xml
scripts/build-runtime.mjs               # 组装 runtime/
runtime/                                # 构建产物（gitignore，194MB）
docs/HANDOFF.md                         # 技术交接
docs/SESSION-SUMMARY.md                 # 本文
```

### 3.2 UI 适配层 `E:/github/ZCode/packages/web-ide`（分支 `ide-integration`）

```
package.json / vite.config.ts / index.html
src/main.tsx        # 连接 server、项目自动绑定、identity、locale
src/idePlatform.ts  # IPlatformService 的 IDE 实现
src/ideBridge.ts    # JCEF 请求/响应 + 浏览器 dev 兜底
src/styles.css
```

### 3.3 构建产物

```
E:/github/zcode-ide/zcode-ide/build/distributions/zcode-ide-0.1.0.zip   49MB
```

包结构：

```
zcode-ide/
├── lib/           插件 jar + Kotlin 依赖
└── runtime/
    ├── server/    entry-http.js
    ├── web/       web-ide 构建产物
    ├── agent/     zcode.cjs + provider
    ├── node_modules/
    └── LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md
```

---

## 4. Bug 与修复记录

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 安装后顶掉 ZC GUI | 两个包根目录都是 `intellij-plugin/` | 模块改名 `zcode-ide`，包根目录变为 `zcode-ide/` |
| 2 | 工具窗口 id 冲突 | 两个插件都用 ToolWindow id `ZCode` | 改为 `ZCodeIDE`，显示名 "ZCode IDE" |
| 3 | 图片上传失败 | 桥在 EDT 上 `invokeAndWait` | 桥请求放后台线程；`onEdt` 先判断是否已在 EDT |
| 4 | 语言默认英文 | `localePreference=system` → `navigator.language=en-US` | 插件注入 `ideLocale`，web-ide 传给 `ZCodeIntlProvider` |
| 5 | `project.remote-project-required` | 独立 server 的 `ownerHostId` 不是 `local`，必须有 projectId | web-ide 启动时 `saveProject`（不传 hostId）并 `startDraft` 绑定 |
| 6 | `project.cwd-not-in-roots` | 项目根是反斜杠，工作区路径是斜杠，严格比较失败 | 用项目根 `canonicalPath` 渲染 Root |
| 7 | `task-group.host-identity-mismatch` | 未传 `workspaceIdentity`，hostId 落到 `local` | 用 `buildServerRemoteWorkspaceIdentity({serverId, workspacePath})` 构造 |
| 8 | 关闭全部会话后显示「没有要显示的内容」 | IntelliJ 工具窗口空状态，Content 被关闭后未重建 | **待修**：`canCloseContents=false` + `ContentManagerListener` 重建 |

---

## 5. 当前状态

### 已验证

- 官方 server 在纯 Node 24 运行，无 Electron
- 官方 UI 在浏览器和 JCEF 中渲染
- 登录态、项目列表、会话列表正常
- 发送消息、Agent 回复、流式输出正常
- 自动创建/绑定项目与草稿
- 分组 host identity 修复
- 完整包解压后可独立启动 server

### 未完成

1. 修复「关闭全部会话后的空状态」（见上表 #8）
2. M3：主题同步、选区/文件发送到输入框、多标签
3. M4：ezn 自动安装 Node 24（目前要求机器预装）
4. 沙箱 IDE 实机验证（`runIde` 有上游 bug；当前内存也不足）
5. 体积优化（web dist 49MB、agent 29MB）
6. 提交代码：`ZCode` 的 `ide-integration` 分支有未提交改动；`zcode-ide` 尚未 `git init`

---

## 6. 给下一个对话的起点

先读：

1. `E:/github/zcode-ide/docs/HANDOFF.md` —— 架构、路径、构建命令、已知问题
2. 本文档 —— 需求脉络与 bug 历史
3. `E:/github/zcode-ide/README.md` —— 项目说明

然后按需：

- 改插件（Kotlin）→ `E:/github/zcode-ide/zcode-ide/src/main/kotlin/`
- 改 UI 适配（TS）→ `E:/github/ZCode/packages/web-ide/src/`
- 打包 → `node scripts/build-runtime.mjs` + `./gradlew :zcode-ide:buildPlugin`

当前最高优先级：修「关闭全部会话后的空状态」，然后是 M3 的选区发送。

---

## 7. 关键路径速查

| 内容 | 路径 |
|---|---|
| 插件源码 | `E:/github/zcode-ide/zcode-ide/src/` |
| UI 适配源码 | `E:/github/ZCode/packages/web-ide/src/` |
| 官方后端源码 | `E:/github/ZCode/packages/server/src/` |
| 官方共享 UI | `E:/github/ZCode/packages/ui/src/` |
| Agent 源码 | `E:/github/ZCode/apps/zcode-cli/` |
| 参考骨架 | `E:/github/zcode-jetbrains-plugin/` |
| asar 解包 | `E:/github/zcode-asar/app/` |
| 构建产物 | `E:/github/zcode-ide/zcode-ide/build/distributions/zcode-ide-0.1.0.zip` |
| 运行时目录 | `E:/github/zcode-ide/runtime/` |
| IDE 日志 | `C:/Users/<user>/AppData/Local/JetBrains/IntelliJIdea2026.2/log/idea.log` |
| 已安装插件 | `C:/Users/<user>/AppData/Roaming/JetBrains/IntelliJIdea2026.2/plugins/zcode-ide/` |
