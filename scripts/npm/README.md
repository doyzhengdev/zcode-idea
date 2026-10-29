# zcode-idea

ZCode 的 **JetBrains IDE 插件**：把官方 Web UI 与本机 ZCode server 装进 IDE，
让 Agent 直接在你的项目里工作。插件基于官方源码
[`zai-org/ZCode`](https://github.com/zai-org/ZCode)（`packages/server` + `packages/ui`）；
这个 npm 包是它的安装器（约 33KB，不含插件本体）。

## 为什么还要一个 IDE 插件

官方 ZCode 客户端是独立的 Electron 应用：它不知道你 IDE 里开着哪个项目、选中了哪段代码、
文件树长什么样，用起来是"两个应用来回切"。

IDE 插件的价值是把 Agent 放进代码所在的地方：

- **官方代码原样复用**：界面、会话、Agent 行为全部来自官方代码；插件对官方源码的改动约
  0.04% 的行（19 个文件）。IDE 形态下会隐藏少量桌面专属入口（新建项目、插件市场、内置终端
  等），另有若干能力明确不支持，见下文。
- **项目就是上下文**：工具窗口绑定当前 IDE 工程，右键文件/目录、编辑器选区一键加入对话，
  Agent 读的就是你正在改的这份代码。
- **外壳交给 IDE**：窗口、托盘、通知、更新、快捷键由 IDE 承担，插件不用再带一个 Electron
  外壳，也不用维护第二套窗口管理。

## 适合谁用

- **主力用 JetBrains IDE 的开发者**（IntelliJ IDEA、WebStorm、PyCharm、GoLand、CLion、
  DataGrip 等）：不用离开 IDE，也不用再开一个独立客户端。
- **已经在用 ZCode 的人**：同一套会话、模型、MCP、记忆（同一个 `~/.zcode`），
  只是把入口搬进 IDE 侧栏，接着用就行。
- **讨厌在两个应用之间切换的人**：代码、文件树、选区、终端都在 IDE 里，Agent 也在这里。
- **多项目并行的人**：全 IDE 共用一个 server，多个窗口各自绑定项目，关掉重开秒连。

## 功能

- 工具窗口内嵌官方 ZCode UI；索引期间照常可用。
- 文件/目录右键、编辑器选区「添加到对话」，消息链接点开定位到 IDE 编辑器对应行列。
- 通知、打开外部链接、文件对话框等本机能力经桥转发给 IDE。
- 会话与桌面端互通（同一 `~/.zcode`、同为 local 宿主）；共享 server 支持多项目窗口。
- 手机 Web 远控：面板里生成二维码，手机端接管当前 IDE 项目。
- 安装包内置 runtime（当前发布为完整包），打开面板无需联网下载；若使用薄包版本，
  首次打开会按需下载 runtime。

## 注意

- **不要和桌面客户端同时运行**：两边共用 `~/.zcode`（SQLite），同时开会锁冲突；
  切换时关掉另一个即可，会话和配置都不会丢。
- **依赖 IDE 自带的浏览器组件（JCEF）**：IDE 未启用 JCEF 时面板会给出提示，不会崩溃。
- **首次打开工具窗口需要几秒**：要拉起全 IDE 共享的 server，之后常驻，再开面板是秒开。

## 明确不支持

下面这些能力在 IDE 形态下**不提供**（是底层能力缺失，不是入口被藏起来）。对应入口不会出现；
从别处触发时会返回明确的"不支持"，不会静默失败。

- **远程工作区 / remote attach**：连接远端机器上的项目。
- **Docker 目标**：容器内运行会话，目标列表为空。
- **WSL / SSH 目标**：同上，目标列表为空。
- **Computer Use**：桌面自动化能力未实现。
- **内置浏览器侧栏**：IDE 里不提供内嵌浏览器面板。
- **桌面外壳类**：窗口控件、托盘、应用菜单、全局快捷键、剪贴板/电源管理、应用内自动更新——
  由 IDE 自身承担，插件不重复实现。
- **跨窗口同步与截图**：多窗口标签/未读数同步、窗口截图、Chrome 浏览器数据导入不提供。

此外，IDE 形态下会隐藏少量桌面专属入口（新建项目、项目分组与搜索、插件市场、内置终端、
右侧面板等），相应能力在 IDE 里有等价做法（用 IDE 自己的新建项目 / 终端 / 项目树）。

## 实现原理（运行机制）

```text
IDE 进程
├─ ZCodeToolWindowFactory ──► ZCodePanel（JCEF，每个窗口一个）
│    ├─ 加载 http://127.0.0.1:<固定端口>/?token=…&ideWorkspace=<项目>&ideHost=1
│    ├─ Web → IDE：JBCefJSQuery ──► IdeBridge（打开文件/目录、通知、对话框、远控…）
│    └─ IDE → Web：executeJavaScript ──► __zcodeIdeMessage（选区/文件引用、主题）
├─ ZCodeIdeService（项目级门面：面板注册、待发消息队列）
├─ ZCodeServerManager（应用级单例，全 IDE 一个 server）
│    └─ node entry-http.js（官方 server）
│         └─ 按 workspaceKey 各自 spawn agent（zcode.cjs app-server --stdio）
└─ RemoteControlBridge（应用级）──► node remote-bridge（官方 relay device 桥）
```

插件自身只提供两样东西：**底层 Node**（运行官方 server 与 agent）和 **IDE 自带的浏览器
内核**（JCEF 承载官方页面，不再带 Electron 或独立浏览器）；其余是薄薄一层本机能力桥与
进程/端口/runtime 管理。

几条关键约束：

- **页面里的普通业务请求不经过插件**：UI ↔ server 走同源 HTTP/WS，只有"本机能力"才过桥。
- **全 IDE 共用一个 server、端口固定**：所有窗口同 origin，`localStorage`（草稿、模型选择、
  界面偏好）才不会丢；项目路径靠 URL 的 `ideWorkspace` 传入，server 不绑定项目。
- **runtime 五级解析**：`-Dzcode.ide.runtime` → `ZCODE_IDE_RUNTIME` → 开发期 `vendor/ZCode`
  → 插件目录 `runtime/`（完整包）→ `~/.zcode/ide/runtime` 下载版。
- **IDE 形态只做轻度精简**：侧栏与头部按 IDE 场景收敛入口，桌面端与独立 Web 端行为不变。

## 安装与升级

不在这里提供手动命令：安装与升级统一由 **agent 执行**——告诉 agent 要装/升到哪个版本、
装到哪些产品或目录即可，agent 会完成安装并在结束后核对版本。

## 相关链接

- 官方 ZCode 源码（上游）：https://github.com/zai-org/ZCode
- ZCode 产品主页：https://zcode.z.ai
