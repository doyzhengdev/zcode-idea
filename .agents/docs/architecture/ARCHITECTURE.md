# 架构与仓库拓扑

> 项目定位、两个仓库的关系、本仓库目录结构、运行时架构与两条通道。
> 索引见 [`../../AGENTS.md`](../../../AGENTS.md)；改动落点见 [`WORK-MAP.md`](../development/WORK-MAP.md)。

## 1. 30 秒上下文

本项目是 **JetBrains IDE 插件**：在 IDE 内用 JCEF 内嵌**官方 ZCode Web UI**，后端直接跑官方 `@zcode/server`（Node ≥ 24），**不依赖 Electron**。

- 插件工程：`E:\work\zcode-ide`（Gradle + Kotlin，**扁平单模块**，`rootProject.name = zcode-ide`）
- 官方源码 fork：`vendor\ZCode`（独立 git 仓库，分支 `ide-integration`，被 `.gitignore` 忽略，源仓库 `github.com/zai-org/ZCode`）
- 只替换两样东西：Electron 窗口容器 → JCEF；Electron preload 桥 → `JBCefJSQuery` + 自定义 `IPlatformService`
- 不做：远程工作区、Docker/WSL、Computer Use、内置浏览器 side pane（首期）；**Web 远控已支持**（device 桥，见 [`PROJECT-MAP.md`](./PROJECT-MAP.md)）
- 相对上游改了哪些文件、审查顺序与同步风险：见 [`CHANGES-VS-UPSTREAM.md`](../upstream/CHANGES-VS-UPSTREAM.md)

## 2. 仓库拓扑

```
E:\work\
└── zcode-ide\                 # 本仓库（插件产品）：插件 shell、构建、文档、部署
    ├── src\                   # Kotlin 插件源码（包名 dev.zcode.ide）
    ├── scripts\               # runtime 组装 + 一次性 SQLite 数据迁移脚本
    ├── .agents\docs\          # 技术文档与会话纪要（本目录）
    ├── .agents\skills\        # 项目级 skill（部署到本机 IDE）
    ├── dist\                  # 组装后的运行时（gitignore，约 194MB）
    └── vendor\ZCode\          # 官方源码 fork 工作副本（独立 git 仓库，gitignore，分支 ide-integration）
        ├── packages\web-ide\  # 我们新增的 IDE 版 Web 入口
        ├── packages\ui\       # 官方 React 组件库（含 ideHost 门控补丁）
        ├── packages\server\   # 官方 HTTP/WS 后端（含 local 宿主与数据修复补丁）
        ├── packages\shared\   # 身份/路径工具（含 Windows 盘符修复）
        └── apps\zcode-cli\    # Agent CLI / zcode.cjs
```

两个仓库的关系：`zcode-ide`（插件）与 `vendor/ZCode`（fork，自带 `.git`）各自提交、各自推 Work；插件仓库把 fork 目录整体忽略，只用 `vendor/zcode.lock` 记录构建所需的 commit。

参考目录（通常不修改）：`E:\work\zcode-jetbrains-plugin`（JCEF 宿主写法参考）、`E:\work\zcode-asar`（桌面端 asar 解包，仅分析用）。

remote 约定：`origin` = Work（`github.com/zai-org/ZCode` / `github.com/doyzhengdev/zcode-idea`），`upstream` = 官方（仅 fetch）。同步流程见 [`ZCODE-UPSTREAM-SYNC.md`](../upstream/ZCODE-UPSTREAM-SYNC.md)。

## 3. 目录结构（本仓库）

```
src/main/kotlin/dev/zcode/ide/
├── runtime/RuntimeLayout.kt        # runtime 定位（仓库布局 / 打包布局）
├── runtime/NodeRuntime.kt          # Node 查找（系统 24 优先）
├── runtime/NodeProvisioner.kt      # Node 自动供给：本机没有 24.x 时走镜像下载到插件目录
├── runtime/ServerProcess.kt        # 启 server、全局固定端口、token 持久化、健康检查、杀进程树
├── service/ZCodeServerManager.kt   # 应用级共享 server 生命周期 + 重启广播（全 IDE 单进程）
├── service/ZCodeIdeService.kt      # 项目级门面：面板注册 + IDE→Web 消息队列（不持有进程）
├── ui/ZCodePanel.kt                # JCEF 面板、桥注入、主题、Ctrl+W、消息推送、reload 重建
├── ui/ZCodeToolWindowFactory.kt    # ToolWindow 内容与重建兜底
├── bridge/IdeBridge.kt             # Web→IDE 能力分发（文件对话框/打开文件/落盘/通知）
├── action/SendToZCodeComposerAction.kt  # 右键添加文件引用到对话
├── action/SendSelectionToZCodeComposerAction.kt  # 编辑器选区添加路径+行号到对话
└── startup/PromoteZCodeActionsActivity.kt  # 启动后把两个右键动作置顶
src/main/resources/icons/zcode.png          # 官方 16×16 图标（含 @2x）
src/main/resources/META-INF/pluginIcon.png  # 官方插件图标（含 @2x）
src/main/resources/META-INF/plugin.xml     # 扩展、ToolWindow、Action 注册
src/main/resources/META-INF/jcef-dependency.xml  # JCEF 可选依赖
build.gradle.kts                    # 根=模块；把 dist/ 拷进插件 runtime/ 再打包
settings.gradle.kts                 # rootProject.name 决定 zip 内层目录名
gradle.properties                   # 平台 2025.1 / 插件版本 0.1.0
scripts/build-runtime.mjs           # 组装 dist/（web/server/agent/node_modules/许可）+ BUILD-INFO
scripts/bootstrap.mjs               # 按 vendor/zcode.lock 准备 vendor/ZCode（--check/--update）
scripts/ci-build.mjs                # CI 单入口：clone/install/build/runtime/buildPlugin + sha256
scripts/patch-budget.mjs            # 补丁面统计与预算闸门（超 patchBudget 即失败）
scripts/migrate-tasks-to-local.cjs  # 一次性：remote 会话并入 local（dry-run/--apply）
scripts/fix-task-workspace-keys.cjs # 一次性：修复 workspace_key 归一化
.agents/docs/                       # 技术文档与会话纪要，按类型分目录（索引见 README.md）
```

## 4. 架构与两条通道

```
IntelliJ 2025.1+ (JDK 21)
├── ToolWindow / JBCefBrowser（每个项目窗口一个，共用下面的 server）
│     └── http://127.0.0.1:<port>/?token=<t>&ideWorkspace=<项目路径>&ideLocale=..&ideTheme=..&ideHost=1
│           └── packages/web-ide/dist（官方 Root + IDE 版 IPlatformService，按 ideWorkspace 锁定项目）
│                 └── WS /ws → @zcode/server（Node 24，local 宿主形态，全 IDE 单进程）
│                       └── 按 workspaceKey 各自 spawn agent/zcode.cjs app-server --stdio
└── JBCefJSQuery ←→ IdeBridge
```

| 通道 | 方向 | 用途 | 实现 |
|---|---|---|---|
| 浏览器网络 | 双向 | UI ↔ server 的 HTTP + WebSocket RPC | 同源 `127.0.0.1:<port>`，`?token=` 换 Cookie |
| JBCefJSQuery | Web → IDE | 文件对话框、打开文件、通知等 | JS 调 `window.__ZCODE_IDE_QUERY__(json)`，Java 回 `__zcodeIdeResolve(id, ok, payload)` |
| `executeJavaScript` | IDE → Web | 右键发送文件引用 | `window.__zcodeIdeMessage(json)`；页面未加载时面板内排队 |

JCEF 就是 Chromium，`fetch`/WebSocket 正常可用；它拿不到的是 IDE API 与本地文件系统，所以需要第二条通道。

实现细节（桥的注册与回填、主题同步、端口持久化、identity、ideHost 精简、文件打开链路）见 [`HANDOFF.md`](./HANDOFF.md)；要定位"改哪个文件"用 [`PROJECT-MAP.md`](./PROJECT-MAP.md)。
