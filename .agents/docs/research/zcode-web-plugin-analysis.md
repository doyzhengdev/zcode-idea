# 市场插件 ZCode Web 实现原理分析（与本地方案对照）

> 分析日期：2026-10-24
> 分析对象：JetBrains Marketplace 插件 [ZCode Web](https://plugins.jetbrains.com/plugin/34418-zcode-web)（id 34418）
> 对照对象：`E:/github/zcode-ide/.zcode/plans/plan-sess_cbd89817-6996-4b1e-a787-b1effebfb4f0.md`（下称“计划”）
> 用途：作为新对话的上下文，避免重复调研

---

## 0. 一句话结论

**不是同一个方案，但同源。**

- 市场插件是“**官方 Web 开发服务器 + JCEF + 运行时 DOM 注入**”的轻量外壳：63 KB，不打包运行时，要求用户本机有 ZCode 源码并自己跑 `pnpm dev:web`。
- 本地计划是“**基于官方 UI 源码自建 web-ide + 替换 IPlatformService + 插件自管 Node 运行时**”的产品化路线。
- 两者只在“JCEF 承载官方网页”和“文件引用注入”这一层重合；计划的核心增量（自建 web-ide、平台服务桥、进程/端口/token 管理、自带运行时）插件完全没有。
- 插件唯一值得直接借鉴的硬结论：计划里用的 `zcode:add-workspace-file-to-chat` 事件通道**实测可用**，载荷字段与官方源码一致。

---

## 1. 调研证据与可复现步骤

### 1.1 Marketplace 元数据

通过 JetBrains 公开 API 获取（页面本身是 SPA，WebFetch 抓不到正文）：

```bash
curl -sL "https://plugins.jetbrains.com/api/plugins/34418"
curl -sL "https://plugins.jetbrains.com/api/plugins/34418/updates?page=0&size=5"
```

关键字段：

| 字段 | 值 |
|---|---|
| 插件 id / xmlId | `34418` / `com.aicn.zcode` |
| 名称 | ZCode Web |
| 版本 | 0.1.1 |
| since-build | `251.0`（2025.1+，全 JetBrains IDE） |
| jar 大小 | 63,648 字节 |
| vendor | aicn（未认证组织） |
| pricing | FREE |
| 源码地址 | `https://github.com/pcyanga/deepseek-harness-phpstorm-plugin` |

### 1.2 直接下载 jar 并反编译核对

```bash
curl -sL "https://plugins.jetbrains.com/files/34418/1176622/zcode-web-signed.jar" -o zcode-web.jar
unzip -l zcode-web.jar
javap -p -c com/aicn/zcode/PluginSettings.class
javap -p -c com/aicn/zcode/HarnessManager.class
javap -p -c com/aicn/zcode/WebConsoleToolWindowSession.class
```

jar 内容（共 17 个文件，约 118 KB 解压后）：

```
com/aicn/zcode/HarnessManager.class
com/aicn/zcode/PluginSettings.class
com/aicn/zcode/SettingsDialog.class
com/aicn/zcode/WebConsoleToolWindowFactory.class
com/aicn/zcode/WebConsoleToolWindowSession.class
com/aicn/zcode/ZCodeClient.class
icons/zcode.svg
META-INF/plugin.xml
web/chip-overlay.js      (8.6 KB)
web/ui-trim.js           (10.3 KB)
```

**没有任何 runtime / web 构建产物 / node_modules。**

### 1.3 与源码仓库的关系

- 源码仓库 HEAD 是 `DeepSeek Harness Web` 0.3.19，包名 `com.aicn.web`，默认端口 3080、启动命令 `pnpm dsh web --no-open`。
- 市场版是 ZCode 改名版 0.1.1，包名 `com.aicn.zcode`，默认目录 `F:\ZCode`、命令 `pnpm dev:web`、端口 5173。
- 两者类结构、字段、方法名、看门狗逻辑、`taskkill /F /T /PID`、token 捕获正则完全一致；连默认目录都保留作者机器路径（`F:\deepseek-harness` → `F:\ZCode`）。**可以确认是同一套代码的两次品牌化构建**，但注入脚本按目标产品分叉：市场版 `chip-overlay.js`（8.6 KB）是针对 ZCode DOM 重写的 v4，仓库 HEAD（36 KB）仍针对 DeepSeek Harness 的 Lexical 结构；`ui-trim.js` 也因两边类名/文案不同而各自维护。

### 1.4 官方源码交叉验证（`E:/github/ZCode`）

```bash
grep -rn "zcode:add-workspace-file-to-chat" packages
# packages/ui/src/lib/workspaceFileDrag.ts:4

grep -rn "__zcodeLexicalInputE2E" packages | grep -v /test/
# packages/ui/src/LexicalChatInput.tsx:919-936（生产代码里暴露的 E2E 桥）

grep -rn 'v4-composer-input' packages
# 多处 e2e 测试使用；composer 输入框的 data-testid
```

`packages/ui/src/lib/workspaceFileDrag.ts:7-14` 的载荷定义：

```ts
export interface WorkspaceFileDragPayload {
  type: "file" | "directory";
  workspacePath: string;
  workspaceIdentity?: string;
  path: string;
  relativePath: string;
  name: string;
}
```

---

## 2. 插件实现原理（逐层拆解）

### 2.1 工程形态

- `plugin.xml` 只注册一个右侧 ToolWindow（`id=ZCodeWeb`），依赖 `com.intellij.modules.platform`。
- 构建是 `build.ps1` + 裸 `javac`，**不是 Gradle/Kotlin**。
- 5 个 Java 类承担全部逻辑，其中 `WebConsoleToolWindowSession` 约 50 KB 字节码，是绝对核心。

### 2.2 服务生命周期：应用级单例 `HarnessManager`

设计要点：

1. **全局唯一**：服务是 IDE 级共享的，所有项目窗口复用；切项目/关工具窗不杀服务。
2. **探活**：`GET /`，任何 HTTP 应答（含 401/403/3xx）都算在线，2 秒超时。
3. **启动**：`ProcessBuilder("cmd", "/c", startCommand)`，工作目录为用户配置的 `harnessDir`；把项目根通过环境变量 `ZCODE_SERVER_WORKSPACE` 传给服务。
4. **token 捕获**：后台线程排空 stdout/stderr，用正则 `(https?://\S*token=\S+)` 从启动输出里抓 URL token，供 JCEF 拼 `/?token=`。
5. **状态机**：`OFF(0) / STARTING(1) / ON(2)`；5 秒看门狗：
   - STARTING 超过 60 秒强制落定 OFF；
   - STARTING 但实际探活成功 → 纠正为 ON；
   - ON 但连续 3 次（约 15 秒）探活失败 → 转 OFF。
6. **停止**：`taskkill /F /T /PID <pid>` 杀进程树；手动停止后最多轮询 12 秒等待端口释放，期间反复补杀，避免“自启实例没死透却按外部实例算 ON”。
7. **外部实例识别**：已有外部服务在线时直接复用，永不误杀。

默认配置（`PluginSettings` 字节码常量）：

```
DEFAULT_DIR  = F:\ZCode
DEFAULT_CMD  = pnpm dev:web
DEFAULT_PORT = 5173
baseUrl      = http://127.0.0.1:5173
```

三项配置（目录/命令/端口）全空 = “未配置”，此时不探测、不启动，工具窗显示安装引导。

### 2.3 UI 承载：JCEF 加载官方 dev server

- `JBCefApp.isSupported()` 检查；未启用时显示开启提示。
- `new JBCefBrowser()`，`loadURL(browserUrl())`，URL 为 `http://127.0.0.1:5173/?token=...`。
- **加载的是 `pnpm dev:web` 起的 Vite 开发服务器页面**，不是生产构建，也没有自定义 web-ide。
- 导航自愈：3 / 8 / 18 秒后检查 URL 是否仍是 `about:blank`，是则重发导航；token 晚到时补一次带 token 的导航（同一 token 只补一次）。
- 顶栏四个按钮：服务开关、刷新、系统浏览器打开、设置。
- 中央用 `CardLayout` 在“浏览器卡”和“安装引导卡”之间切换。

### 2.4 IDE → 网页的注入

**a) 拖放**：在 `browser.getComponent()` 上挂 AWT `DropTarget`（不是 HTML5 拖放），解析 `Transferable` 的多种 DataFlavor：

- 文件列表（`javaFileListFlavor` / `text/uri-list`）；
- IntelliJ 的 `VirtualFile`、`PsiElement`、`FileEditor`、`Document` 等；
- 纯文本里能解析出的现存路径；
- 上限 50 个文件、递归深度 8。

**b) 编辑器选区**：全局 `SelectionListener`，选区稳定 400ms 后，在选区上方弹自定义 `JBPopup`（“添加到对话”浮条，Qoder 风格）；滚动跟随、失焦收起、选区变化即取消。点击后才注入。

**c) 注入方式**：`executeJavaScript` 调用页面内函数：

```js
window.__zcAddRefChip("<绝对路径>[:起-止]", "<短标签>")
window.__zcAppendText("<纯文本>")
```

### 2.5 `chip-overlay.js`：三级降级注入（核心）

该脚本（jar 内 `/web/chip-overlay.js`）在注入时被一起 `executeJavaScript` 到页面，采用三级策略：

1. **首选：官方原生事件**
   ```js
   new CustomEvent("zcode:add-workspace-file-to-chat", {
     cancelable: true,
     detail: { type, workspacePath, path, relativePath, name }
   })
   ```
   该事件正是 ZCode 自己的文件树“添加到对话”通道；`dispatchEvent` 返回 `false`（被 `preventDefault`）说明已被消费，会生成原生彩色 `PromptMentionNode` chip。行号通过 `name`（`文件名:起-止`）随 markdown 进入消息。

2. **次选：Lexical E2E 桥**
   ```js
   document.querySelector('[data-testid="v4-composer-input"]').__zcodeLexicalInputE2E
   ```
   用 `getText()/setText()` 追加 markdown 引用（`[name](./rel/path)` 或 `abs:range`）。这是官方测试用接口，生产代码里也暴露（`packages/ui/src/LexicalChatInput.tsx:919-936`）。用于 composer 被禁用或旧版本没有原生事件时。

3. **兜底：纯文本 token**，直接追加文本。

其他机制：

- `window.__zcWsRoot` 由 IDE 注入项目根，用于把绝对路径转成相对路径，使 chip 与官方文件树风格一致；
- 监听 composer 变空（视为消息已发送），把注入过的值列表通过 `window.__zcSent` 回传；
- 悬浮 chip 显示 ×，点击删除，并通过 `window.__zcChipRemoved` 通知 IDE 清选区；
- 等待 composer 挂载的重试队列（每 400ms，最多 75 次）。

### 2.6 网页 → IDE：只有一条单向桥

- `JBCefJSQuery.create(browser)` 只注册一个 handler；
- 页面侧 `window.__zcSent(valuesJson)` / `window.__zcChipRemoved(value)` 调用 `query.inject(...)` 回到 Java；
- Java 侧据此清空编辑器选区（消息已发送或 chip 被删）。

**没有 Java → JS 的请求/响应通道**，也没有文件对话框、打开文件、通知、主题同步等 IDE 能力。

### 2.7 工作区处理：两条腿

1. **服务端**：启动时设 `ZCODE_SERVER_WORKSPACE=<项目根>`。
2. **页面内**（`WS_REGISTER_JS` + `applyWorkspaceFilter`）：
   - 用页面自己的 `fetch('/api/workspace/create')` 幂等注册项目根（typert 网关，信封 `{type:"client-request", rpcId, method:"workspace/create", payload:{args:{request:{path}}}}`）；
   - `MutationObserver` 监听 DOM，用类名子串匹配（`[class*="groupSection"]`、`[class*="projectRow"]`）隐藏非当前文件夹的工作区组；
   - 自动打开工作区下拉并点选当前文件夹；
   - 等 chip 落到当前文件夹后自动收起侧边栏（一次性）。

### 2.8 `ui-trim.js`：运行时改 UI

- 隐藏“添加工作区”（收起/展开两态都隐藏）；
- 收起态隐藏“搜索会话”；
- 把“选择工作区”chip 置 disabled + `pointer-events:none`，变成静态标签；
- 用 `MutationObserver + 120ms` 防抖持续响应 React 重渲染和 SPA 状态切换。

**这就是该方案最脆弱的部分**：依赖被哈希过的 CSS Module 类名和 `aria-label` 中文文案，官方一次改版就可能失效。

---

## 3. 与本地计划的逐项对照

计划原文：`E:/github/zcode-ide/.zcode/plans/plan-sess_cbd89817-6996-4b1e-a787-b1effebfb4f0.md`
（注：该计划是历史方案；[`HANDOFF.md`](../architecture/HANDOFF.md) 记录了后续已落地的实现，对比时以计划原文为准。）

| 维度 | ZCode Web 插件（市场版 0.1.1） | 本地计划 |
|---|---|---|
| **UI 来源** | 用户本机 `pnpm dev:web` 的 Vite 开发服务器（5173），页面零改动 | 自建 `packages/web-ide`，用官方 `@zcode/ui` 的 `Root` 做生产构建 |
| **后端** | 用户自己起的 dev server；插件只探活/按命令拉起 | 插件自带 `dist` 运行时，`ProcessBuilder` 启动 `entry-http.js` |
| **Node 依赖** | 依赖用户环境的 Node/pnpm，且必须有一份 ZCode 源码 | 校验 Node ≥ 24（用户预装），其余运行时随插件打包 |
| **端口** | 固定 5173 | 每个项目 `ServerSocket(0)` 随机空闲端口 |
| **token** | 从进程 stdout 正则抓取；页面用 `/?token=` | `SecureRandom` 生成 32 字节 base64url；健康检查用 `Authorization: Bearer` |
| **健康检查** | `GET /` 有应答即在线 | 轮询 `/api/server-info`，30 秒超时 |
| **进程模型** | 应用级单例，所有项目共享 | 项目级生命周期，每项目一个 server |
| **IDE 能力层** | 无。文件对话框、打开文件、通知、主题都没做 | 自定义 `IPlatformService`：文件对话框、`BrowserUtil`、`openInFileManager`、通知、主题 |
| **双向桥** | 单向 JS→Java（仅回传发送/删除事件） | `requestId + resolve` 请求响应表（JS→Java→JS） |
| **UI 定制** | 运行时改 DOM（`ui-trim.js`、侧边栏过滤、禁 chip） | 靠 `Root` props（`preferDirectoryBrowser=false`、`isDesktop=false` 等）配置化 |
| **选区注入** | hover 浮条（400ms 防抖）+ 原生 chip | 先按文本附件，必要时在 web-ide 里加自定义事件钩子 |
| **文件注入** | 原生 `zcode:add-workspace-file-to-chat` → E2E 桥 → 纯文本 | 直接 `dispatchEvent` 同一事件；载荷与官方定义一致 |
| **工作区** | `ZCODE_SERVER_WORKSPACE` + 页内 `/api/workspace/create` + DOM 过滤 | 通过 server 的 workspace 参数；不做 DOM 过滤 |
| **主题** | 未处理 | 注入 `document.documentElement.classList.toggle("dark")` + `LafManagerListener` |
| **打包体积** | 63 KB（不含运行时） | 预计 100 MB+（web ~15 MB、server+node_modules 80-120 MB、agent ~15 MB） |
| **工程/构建** | 裸 `javac` + PowerShell | Gradle + Kotlin，IntelliJ Platform Gradle Plugin 2.x |
| **多窗口** | 每工具窗独立会话，服务全局共享 | 每项目独立 server |

---

## 4. 相同点与差异的本质

### 4.1 真正相同的部分

1. **宿主形态**：都用 `JBCefBrowser` + ToolWindow，都不使用 Electron，都通过 JCEF 加载官方 Web UI。
2. **官方 UI 复用**：都不重写聊天界面，消息/模型/设置/审批全部沿用官方页面。
3. **文件引用通道**：都使用 `zcode:add-workspace-file-to-chat` 这个官方事件（插件是首选路径，计划是直接注入）。
4. **token 鉴权**：都用 `/?token=` 的形式让内嵌页完成鉴权。
5. **`JBCefJSQuery`**：都用作页面回传 Java 的通道（但计划的用途和复杂度高得多）。

### 4.2 本质差异

| 差异 | 插件 | 计划 |
|---|---|---|
| **产品定位** | 开发态集成工具：假设用户是 ZCode 开发者 | 可分发的插件：用户不需要源码和构建链 |
| **UI 可改性** | 不能改，只能注入 JS 打补丁 | 可以改，因为自己构建 `web-ide` |
| **IDE 集成深度** | “把网页塞进来 + 把文件塞进去” | “把网页的 platform 层换成 IDE 实现” |
| **脆弱性来源** | 官方 DOM/类名/文案一变就退化 | 上游源码 API 变才需要跟进，但 rebase 成本存在 |
| **实现成本** | 5 个类 + 2 个脚本 | Gradle 多模块 + 运行时打包 + 跨端进程管理 + 桥协议 |

**一句话**：插件解决的是“我本机跑着 ZCode Web，能不能在 IDE 里看”；计划解决的是“给普通用户装一个插件就能在 IDE 里用 ZCode”。

---

## 5. 对本地项目的可执行结论

### 5.1 可以直接借鉴

1. **文件引用事件已验证**：`zcode:add-workspace-file-to-chat` 的 `detail` 就是 `WorkspaceFileDragPayload`（`type/workspacePath/workspaceIdentity?/path/relativePath/name`），官方 composer 会消费并生成原生 chip。计划第 80 行的写法成立。
2. **行号随 `name` 走**：chip 正面只显示文件名，`文件名:起-止` 作为 label 进入 markdown，最终模型收到完整路径 + 行号。这解决了“chip 显示要短、发送要全”的矛盾。
3. **进程看门狗的写法**：启动超时强制落定 + “STARTING 但在线”自校正 + 连续失败才判离线，避免状态自锁。可直接移植到 `ServerProcess`。
4. **停止后的端口轮询补杀**：应对 pnpm 派生子进程脱离进程树的情况，Windows 上尤其必要。
5. **stdout 抓 token 的兜底**：如果运行时未来改成打印 URL，可作为生成 token 之外的备用通道。
6. **`DropTarget` 解析 `Transferable`**：对 `VirtualFile`/`PsiElement`/`FileEditor`/纯文本路径的多路解析，比只处理 `javaFileListFlavor` 完整。
7. **E2E 桥作为最后兜底**：`__zcodeLexicalInputE2E` 是官方生产代码里真实存在的接口，可作为原生事件失效时的降级路径。

### 5.2 明确不要借鉴

1. **`ui-trim.js` 式的 DOM 改写**：依赖哈希类名和中文 `aria-label`，正是自建 web-ide 要消除的脆弱点。
2. **页内 `fetch('/api/workspace/create')` 注册工作区**：计划已经通过 server 参数控制工作区，不需要绕过协议层。
3. **固定端口 + `GET /` 探活**：计划用随机端口 + Bearer 健康检查更稳。
4. **应用级共享单 server**：计划是项目级生命周期，工作区隔离更清晰；但要注意多项目并发时 `~/.zcode` 的 SQLite 锁风险（计划风险第 3 条）。

### 5.3 需要警惕的差异

- 插件能用 `pnpm dev:web`，是因为页面由官方仓库的 Vite 直接提供；计划的 `web-ide` 是自建构建，**必须自己维护 `IPlatformService` 的全部方法**，否则 `Root` 里任何“选择文件/打开目录”入口都会报错。插件通过“隐藏这些入口”（`ui-trim.js`）绕开了这个问题，计划不能这么做，只能真实现。
- 插件的 `chip-overlay.js` 依赖官方 `data-testid` 和 E2E 桥；计划如果锁定官方 commit，风险可控，但升级上游时要回归这两处。
- 市场版与源码仓库 HEAD 的注入脚本已经分叉（ZCode v4 vs DeepSeek Harness 版），说明这类 DOM 注入方案必须针对每个目标页面单独维护，反向印证了其兼容性成本。

---

## 6. 关键文件与行号索引

### 市场插件（jar，反编译）

| 内容 | 位置 |
|---|---|
| 插件注册 | `META-INF/plugin.xml` |
| 配置默认值 | `com/aicn/zcode/PluginSettings.class`（`F:\ZCode` / `pnpm dev:web` / `5173`） |
| 服务生命周期 | `com/aicn/zcode/HarnessManager.class` |
| JCEF/注入/选区/工作区 | `com/aicn/zcode/WebConsoleToolWindowSession.class` |
| chip 注入三级策略 | `web/chip-overlay.js` |
| UI 精简 | `web/ui-trim.js` |
| 探活客户端 | `com/aicn/zcode/ZCodeClient.class` |

### 源码仓库（可读版本，逻辑同源但更新）

| 内容 | 位置 |
|---|---|
| 插件注册 | `resources/META-INF/plugin.xml` |
| 服务管理器 | `src/com/aicn/web/HarnessManager.java`（`runStart` 270-313，`stopOwnedProcesses` 322-343，token 捕获 419-461） |
| 会话主逻辑 | `src/com/aicn/web/WebConsoleToolWindowSession.java`（`init` 294-440，`injectRefChips` 871-894，`injectToComposer` 1294-1309，`applyWorkspaceFilter` 1325-1408） |
| chip 注入 | `resources/web/chip-overlay.js` |
| UI 精简 | `resources/web/ui-trim.js` |

### 官方 ZCode 源码

| 内容 | 位置 |
|---|---|
| 事件常量 | `packages/ui/src/lib/workspaceFileDrag.ts:4` |
| 载荷接口 | `packages/ui/src/lib/workspaceFileDrag.ts:7-14` |
| E2E 桥暴露 | `packages/ui/src/LexicalChatInput.tsx:919-936` |
| composer testid | `[data-testid="v4-composer-input"]` |

---

## 7. 新对话可以直接使用的上下文摘要

> 已分析 JetBrains Marketplace 插件 ZCode Web（34418，`com.aicn.zcode`，0.1.1，63 KB）。它和本地 `zcode-ide` 方案不是同一路线：插件用用户本机的 `pnpm dev:web` 起官方 Web 开发服务器，JCEF 直接加载 5173，靠注入 `chip-overlay.js`（原生 `zcode:add-workspace-file-to-chat` 事件 → `__zcodeLexicalInputE2E` 桥 → 纯文本三级降级）和 `ui-trim.js`（DOM 改 UI）实现 IDE 集成，服务由应用级单例 `HarnessManager` 管理（`taskkill /T /F`、stdout 抓 token、60s 看门狗），只有一个 JS→Java 的 `JBCefJSQuery`。本地方案则是自建 `web-ide` + 替换 `IPlatformService` + 自带 Node 运行时 + 双向桥 + 随机端口/token + 项目级进程。两者只在 JCEF 宿主、官方 UI 复用、`zcode:add-workspace-file-to-chat` 事件、`/?token=` 上有重合。结论：文件引用事件已验证可用；不要借鉴 DOM 改写和固定端口；需要真实现 `IPlatformService`。详细对照见 [`.agents/docs/research/zcode-web-plugin-analysis.md`](./zcode-web-plugin-analysis.md)。
