# IDE 宿主适配原则（isDesktop / 记忆 / MCP）

> 记录时间：2026-10-24。适用仓库：`zcode-ide`（插件）+ `ZCode` fork（ide-integration）。
> 本文回答一个反复出现的问题：**IDE 插件要不要"把自己当成桌面端"？怎么改才不破坏上游？**
> 文件级的适配点清单（哪些文件、什么门控）见 [`PROJECT-MAP.md`](./PROJECT-MAP.md) 第 5 节，本文只讲原则与机制。
> 与桌面客户端的功能差异清单（支持/不支持/行为不同）见 [`IDE-VS-DESKTOP.md`](./IDE-VS-DESKTOP.md)。

## 1. 先把概念拆开：Electron 给了什么，ZCode 自己实现了什么

Electron 提供三层东西：

1. **浏览器内核**（Chromium）——渲染 UI；
2. **Node 运行时**——跑 server / CLI / agent；
3. **原生宿主 API**——`BrowserWindow`（窗口最小化/最大化/关闭）、系统托盘、全局快捷键、原生通知、剪贴板、电源管理、文件对话框、`shell.openPath`、自动更新等。

ZCode 的业务能力（会话、任务、MCP、记忆、聊天 UI、工具链）都是自己实现的；但上面第 3 类"系统能力"在桌面端是**调用 Electron API**，不是自己重写的。

IDE 插件用 JCEF 替换了第 1、2 层（JCEF 自带 Chromium；Node 由插件自己拉起 `@zcode/server`），第 3 层改由 **JCEF 桥 + Kotlin/IDE API** 提供（`IdeBridge.kt` ↔ `idePlatform.ts`）。

所以"能不能让 IDE 被识别为桌面端"的答案不是"不能"，而是：**能力可以逐项补齐，形态要按 IDE 裁剪**。

## 2. `isDesktop` 是什么：形态开关，不是能力探测

上游 UI 里的 `isDesktop` 是一个 boolean prop（`Root` → `App` → 各面板），上游用它**同时**表达两件事：

| 用途 | 例子 |
|---|---|
| **能力**：本机资源是否可读写 | 记忆详情（`SettingsPage` 的 `projectMemoryViewerAvailable`）、MCP 用户目录（`mcpStore` 的目录服务分支）、系统通知、`GitPane` 打开文件管理器 |
| **形态**：桌面端产品外壳 | 窗口控件（最小化/最大化/关闭）、窗口框架背景/圆角、终端入口、插件市场、远程控制、帮助菜单 |

`packages/ui` 里共有约 280 处 `isDesktop` 判断。**它不是能力探测，所以不能指望"某个 platform 字段"去拦截它**——这正是记忆详情页在 IDE 里显示"仅支持在本地桌面端查看"的原因：上游写的是 `Boolean(isDesktop)`。

## 3. 适配原则（本项目约定）

> **能不改官方源码就不改；必须改时，改动最小化、加 `isIdeHost()` 门控，并在提交信息里说明理由。**

优先级从高到低：

1. **只改 `packages/web-ide`（我们自己的入口层）**：
   - `main.tsx`：给 `Root` 传的参数（`isDesktop` 保持 `false`；`supportsEmbeddedBrowser` / `allowRemoteWorkspace` 显式关闭）；
   - `idePlatform.ts`：`IPlatformService` 的具体实现（本机能力走 JCEF 桥或 server RPC）；
   - `styles.css`：仅在 IDE 页面加载的样式补丁（当前无规则，留作形态兜底）。
2. **改 `packages/ui`**：只允许"上游把能力错误地绑在形态开关上、且没有能力位可拦截"的情况，且必须 `isIdeHost()` 门控，桌面端/独立 web 端行为不变。
3. **改 server / CLI / shared**：只在数据层确实缺失时（例如会话身份、路径归一化），风险最高，必须单独立项验证。

### 当前落点（可作为模板）

| 需求 | 做法 | 文件 |
|---|---|---|
| 不伪装桌面 | `isDesktop={false}`。窗口控制、托盘、系统通知、自动更新、剪贴板、电源管理都由 IDE 承担，插件不补 | `packages/web-ide/src/main.tsx` |
| MCP 用户目录读写 | `loadMcpFromUserDirectory` / `saveMcpToUserDirectory` 转发到 `services.mcpSyncService` | `packages/web-ide/src/idePlatform.ts` |
| 归档/置顶不报 `Unknown channel: window-controller` | `forIdeHost()` 代理屏蔽 `windowControllerService` | `packages/web-ide/src/main.tsx` |
| 记忆详情可见 | `isIdeHost()` 并入 `projectMemoryViewerAvailable`（**唯一保留的上游 UI 改动，1 行**） | `packages/ui/src/SettingsPage.tsx` |
| 任务行 running 图标自愈 | sessions-index 订阅失效后按任务变化事件重订 | `packages/ui/src/project-sidebar/useProjectTree.ts` 等（4 个文件，已门控） |

### 明确不需要做桌面化的能力

以下能力在 IDE 里有原生实现，插件**不应该**为了"像桌面端"去补（也是不把 `isDesktop` 置 true 的主要原因）：

- 窗口控制（最小化/最大化/关闭）、窗口框架、桌面顶栏；
- 系统托盘、全局快捷键（与 IDE 自身冲突）；
- 自动更新（由 IDE 插件市场负责）；
- 电源管理、剪贴板（由 IDE/浏览器内核负责）；
- 系统通知：可选。想用 IDE 通知时走 `showTaskNotification` 桥即可，不需要 `isDesktop`。

真正需要"本机数据"的只有两类：**记忆目录**、**MCP 用户目录**。前者上游硬编码在 `isDesktop` 上（一行门控解决），后者是 platform 方法（适配层实现）。

备选方案（不推荐）：把 `isDesktop` 置 true 能一次性打开所有"桌面能力"，但会同时渲染窗口控件与窗口框架、启用系统通知等不需要的行为，实测 JCEF 右上角会出现最小化/最大化/关闭。若将来真的要走这条路，必须用 `styles.css` / `isIdeHost()` 逐项收口形态，并接受上游 DOM 漂移带来的维护成本。

## 4. 记忆（Project Memory）

### 存放规则

```
<cliStorageRoot>/memories/projects/<slug>-<sha256(workspacePath).slice(0,16)>/memory/
```

- `cliStorageRoot` 默认 `~/.zcode/cli`（`getCliStorageRoot(storage.dir)`，`storage.dir` 默认 `~/.zcode`）；
- `slug` = 工作目录 basename；hash 对 **小写化后的绝对路径** 取 sha256 前 16 位；
- 因此**记忆跟着 workspace 路径走**：项目换目录 = 换一套记忆。

### 已发生的坑（2026-10-24）

项目从 `E:\work\zcode-ide` 迁到 `E:\work\zcode-ide` 后：

- 旧记忆：`zcode-ide-c1f4000299cc330f`（16 条，架构/构建/网络/补丁等）
- 新记忆：`zcode-ide-8b81d4057264c907`（本次会话产物）

设置页会显示两个同名 `zcode-ide`，且 agent 只读新目录，表现为"记忆没同步"。

### 处理方式（已执行）

1. 备份整目录到 `~/.zcode/backup/memory-merge-<ts>/`；
2. 旧目录的 `.md` 复制进新目录（同名跳过）；
3. 合并 `MEMORY.md` 索引（按文件名去重，新条目优先）；
4. 旧目录移入备份区，避免设置页出现重名条目。

合并后：`zcode-ide-8b81d4057264c907` = 23 个文件 / 22 条记忆。

**以后换项目路径时**，按同样流程迁移 `memories/projects/<slug>-<hash>` 目录，否则历史记忆会静默失联。

## 5. MCP

### 数据源

- 用户级：`~/.zcode/cli/config.json` 的 `mcp.servers`
- 用户级（AGENTS 约定）：`~/.agents/mcp.json`
- workspace 级：`<workspace>/.zcode/config.json`、`<workspace>/.agents/mcp.json`

桌面端与 IDE 共用同一个 `~/.zcode`，所以**配置本身是同源的**。

### 为什么 IDE 里"已安装 0"

`packages/ui/src/store/mcpStore.ts` 的 `resolveMcpDirectoryService()` 对**本地 workspace 永远返回 null**，强制走 platform 分支（桌面端由 Electron 主进程读 native 目录，同时执行旧 common MCP 迁移）。

而 `packages/web-ide/src/idePlatform.ts` 早期给的是：

```ts
loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
saveMcpToUserDirectory: () => notSupported("MCP 目录管理"),
```

于是列表恒为空、新建/导入也失败——不是配置不同步，是**适配层返回了空 stub**。

### 修复（纯适配层，零官方改动）

`idePlatform.ts` 现在把这两个方法转发给本机 server：

```ts
loadMcpFromUserDirectory → services.mcpSyncService.loadMcpFromUserDirectory(payload)
saveMcpToUserDirectory  → services.mcpSyncService.saveMcpToUserDirectory(payload)
```

`createIdePlatform(services)` 需要在 `connectViaWebSocket` 之后创建，`main.tsx` 已按此顺序调用。

排查口诀：**IDE 里 MCP 列表空 → 先看 idePlatform 的 platform 方法，再看 `~/.zcode/cli/config.json`。**

## 6. 验证方式（JCEF + CDP）

1. 读 `%LOCALAPPDATA%\JetBrains\IntelliJIdea2026.2\jcef_cache\DevToolsActivePort` 拿端口；
2. `curl http://127.0.0.1:<port>/json/list` 找 `title: "ZCode - IDE"` 的页面；
3. `Page.captureScreenshot` 截图；`Runtime.evaluate` 可读 DOM / 调 `services.*`（页面里 `services` 可从 React fiber 的 props 取）。

注意三个坑：

- `location.reload()` 在 JCEF 里**不生效**，必须用 CDP `Page.reload`；
- 表达式里的路径字面量 `\\` 经过 CDP 可能被吃掉，用 `String.fromCharCode(92)` 构造；
- 直连 `subscribeSessionsIndexV4` 会挤掉页面自己的订阅（同 connection/topic 只保留最新），排障后要重载页面。

## 7. 磁盘异常记录（2026-10-24）

构建时发现 `packages/ui/src/SettingsPage.tsx` 与 `ZCode/.git/index` 的**文件头被写成全零**（`od -c` 全 `\0`），导致：

- `vite build` 报 `Invalid Character` at `SettingsPage.tsx 0..1`；
- `git status` 报 `index file corrupt (bad signature 0x00000000)`。

恢复步骤（可复用）：

```bash
# 1. 先从 git 对象库恢复文件（不依赖 index）
git show HEAD:packages/ui/src/SettingsPage.tsx > /tmp/SettingsPage.tsx
cp /tmp/SettingsPage.tsx packages/ui/src/SettingsPage.tsx

# 2. 重建 index（工作区文件保留）
rm -f .git/index && git reset -q
```

教训：**构建报 `Invalid Character 0..1` 时，第一反应应是 `od -c` 看文件头**，不要当成代码语法问题反复改。两个仓库的文件同时被清零，更可能是磁盘 / 杀软 / 备份工具层面，建议定期检查磁盘健康。
