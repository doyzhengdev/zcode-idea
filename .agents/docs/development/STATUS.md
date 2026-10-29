# 当前状态与待办

> 最近更新：2026-10-25。以代码为准；这里只记录端到端验证过的结论与已知缺口。

## 已完成（端到端实机验证）

server/Node 链路、Web UI 渲染、登录态复用、项目/会话、消息与流式回复、主题跟随、`Ctrl+W`、端口复用、历史任务自愈、local 宿主会话互通、IDE 精简侧栏（CSS 下沉 + `isIdeHost` 门控）、**IDE 顶部浮层整块与侧栏入口由 web-ide CSS 承接**（侧栏收起后无孤立图标、无空白占位、会话标题无左侧留白，2026-10-25 实机 CDP 验证；`DesktopTopOverlay.tsx` 还原上游，官方修改文件降至 22）、右键发送文件引用、会话内点文件打开编辑器（含行号定位）、**点文件统一进 IDE 编辑器**（`file`/`patch`/`multi-file-diff`/`text` 覆盖对话链接、预览卡片、变更文件行、工具调用行、面板内文件树，2026-10-24 CDP 逐路径实测）、侧栏 running 图标自愈（订阅失效后按任务事件重订，已迁入 `useWorkspaceSessionsIndexItems` 并按宿主门控）、项目迁移后的记忆合并、IDE 内 MCP 用户目录读写、目录链接定位到 IDE 项目树、编辑器选区发送到输入框（右键菜单实机点击验证）、Node 自动供给（本机没有 24.x 时由 `NodeProvisioner` 镜像下载）、版本锁定与 CI 基建（`vendor/zcode.lock` + `bootstrap`/`ci-build`/`patch-budget` + Windows 工作流）、多窗口共享单 server（`ZCodeServerManager` + URL `ideWorkspace`，2026-10-24 双项目窗口实机验证通过：单 server 进程、各窗口锁定各项目、关单窗不死、退出零残留）、**手机 Web 远控**（2026-10-25，见上）、**workspaceKey 去重**（3 窗口实测 1 server + 1 桥 + 3 agent，面板与手机共用同项目的 agent，2026-10-25 实机验证）。另存为对话框仍需手动点一次确认落盘。

## 进程规模基线（2026-10-25）

`~/.zcode/cli/config.json` 已停用全部拉常驻进程的官方插件（pdf/documents/spreadsheets/presentations/node-repl-host/soundcraft/computer-use）与 MCP（playwright-extension/codegraph）。3 个打开 ZCode 面板的项目窗口 = **5 个 node**：1 server + 1 远控桥 + 3 agent（各 0 子进程），约 1.06GB。agent 一项目一个是官方模型；要用某插件时把对应条目改回 `true` 即可（[变更记录 3](../changes/2026-10-25-3-ide-plugin-mcp-disabled.md)）。

## 未完成

- **手机 Web 远控（已可用，残余项见下）**：真机扫码后可看任务列表、打开会话、发消息、在 ZCode 全部项目间切换（2026-10-25 实机验证）；模拟 terminal 全链路（配对 → bootstrap → workspace-list → bridge → RPC）跑通。workspaceKey 已统一为 server 原始写法，面板与手机共用同一 agent（[变更记录 2](../changes/2026-10-25-2-ide-remote-workspace-key-dedup.md)）。残余：`platform-request`（附件/MCP 目录）返回"暂不支持"；手机与 IDE 同时驱动同一 task 的并发语义未测；整次 IDE 重启会在 relay 遗留一个离线旧设备（sid 换新），未做自动清理。见 [变更记录](../changes/2026-10-25-ide-web-remote-control.md)
- 「审查」按钮与变更文件行共用 `patch` 源，现在两者都在 IDE 编辑器打开文件；想在内置面板看 diff 需要新增 `openDiff` 桥方法对接 IDE 自带 diff（见 [`INVARIANTS.md`](./INVARIANTS.md) 第 21 条）
- 重启广播/重试分流的实机验证（故意杀 server 后点重试，触发 `ZCodeServerManager.restart` 广播）
- 消息静默丢弃缓冲：IDE→Web 推送在前端 handler 注册前的窗口期会丢（`queuedWebviewMessage` 单槽也会覆盖），修法见 [`OPTIMIZATION-REVIEW-2026-10-24.md`](../research/OPTIMIZATION-REVIEW-2026-10-24.md) 3.5
- 共享 server 的体验边界：第二个窗口在首个窗口下载 Node 期间阻塞且无进度显示；前端 `onClose` 为空，server 重启未收到广播的窗口页面会假死
- 体积优化（web dist ~49MB、agent ~29MB）
- 欢迎页（无活动任务）没有右上角 ➕：上游 `shouldRenderWorkspaceHeader` 在无 activeTask 时整个 header 不渲染，ActionSection 里的 ➕ 也一起消失
- 工作区外的临时目录/临时附件仍走内置文件树（项目树里没有对应节点）；新对话模型可能被旧会话回执覆盖（上游行为）
- `runIde` 上游 bug、官方「新建项目」对话框在 Web 模式不可用（已用启动时 `saveProject` 绕过）
- 源码 3.16.2 < 客户端 3.16.3；2026-10-25 fetch 确认上游 `main` 仍停在 `3c5b2276`、没有新 tag，等官方公开后按 [`ZCODE-UPSTREAM-SYNC.md`](../upstream/ZCODE-UPSTREAM-SYNC.md) 同步
- 跨进程会话（桌面客户端正在跑的会话）在 IDE 侧栏拿不到实时 running 状态，属于 local 宿主共享 `~/.zcode` 的边界
