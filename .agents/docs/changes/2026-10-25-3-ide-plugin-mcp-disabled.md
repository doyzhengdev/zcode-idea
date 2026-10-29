# 2026-10-25 · 停用全部拉常驻进程的官方插件与 MCP，进程基线降至 5 个 node

- **范围**：本机 `~/.zcode/cli/config.json`（用户级环境配置，不入库；与桌面客户端共用）
- **触发**：用户发现 3 个 IDE 窗口起了 25+ 个 node 进程，确认这些插件/MCP 全都不用
- **提交**：无（非仓库源码；备份见下）

## 改动内容

`~/.zcode/cli/config.json`（备份：`~/.zcode/cli/config.json.bak-20261025-plugins-off`）：

| 配置 | 改动 | 原因 |
|---|---|---|
| `plugins.enabledPlugins`：pdf / documents / spreadsheets / presentations / node-repl-host / soundcraft / computer-use | 置 `false` | 这 6 类每 agent 拉起 5 个插件宿主 + node-repl 宿主（约 650MB）；computer-use 是 node-repl-host 的开关（官方规定 browser-use / computer-use 任一启用必拉宿主） |
| `mcp.servers`：playwright-extension / codegraph | 加 `"enabled": false` | stdio MCP 一客户端一进程，每个 agent 各一份 |
| `plugins.enabledPlugins`：android-emulator / browser-use（原已 false） | 不动 | android-emulator 无常驻进程，只按需起模拟器 |

每个官方插件的进程由 manifest 的 `defaultEnabled` 决定，`enabledPlugins` 显式写 `false` 可覆盖（判定在
`services/src/commands/commandsService.ts` 的 `enabled = config.enabledPlugins[pluginId] ?? defaultEnabled`）。

## 进程账本（改前 → 改后）

每个打开 ZCode 面板的项目会拉 1 个 agent；agent 在会话初始化时按上面的配置拉插件宿主与 MCP：

```
改前（3 窗口）：1 server + 1 桥 + 3 agent + 3×7 宿主/MCP = 26 个 node，约 3.0GB
改后（3 窗口）：1 server + 1 桥 + 3 agent（0 子进程）      =  5 个 node，约 1.06GB
```

改后实测：杀掉旧 agent 让面板自动重拉，新 agent 0 子进程；CDP 确认面板正常（bridge 注入、`ideHost=1`）。

## 为什么不是"按需启动"

插件宿主 / MCP 的加载点是**工作区会话初始化**，官方没有"首个工具调用才拉"的懒加载（桌面客户端同样如此；
桌面显得进程少是因为会话空闲后宿主会被回收、且只开一个窗口）。要把某插件用起来：把对应条目改回 `true`
（或 ZCode 设置里启用），下次 agent 拉起时生效，无需改本仓库代码。

## 行为影响

- ZCode 对话（IDE 与桌面通用）不再有：pdf/文档/表格/演示附件处理、soundcraft、`node_repl`、
  computer-use、browser-use、playwright MCP 工具。AI 会话里原本依赖这些工具的验证路径改走 Bash/CDP。
- agent 一项目一个不变（官方模型，见 [`INVARIANTS.md`](../development/INVARIANTS.md) 第 23 条）。

## 验证

- `Get-CimInstance Win32_Process` 全量盘点：本插件 5 个 node，其余 node 属于 ezllm（3）、
  JetBrains coding-copilot 插件的 playwright-mcp（3）、桌面客户端残留宿主（2，其重启后消失）。
- 杀 agent → 面板自动重拉 → `ZCode agent process started` 日志 key 为规范写法、子进程 0 个。
- CDP `typeof window.__ZCODE_IDE_QUERY__ === 'function'`、`ideHost=1`、标题正常。

## 风险 / 后续

- 桌面客户端共用此配置；它当前的 2 个残留宿主进程要等它重启才消失。
- 若某天需要附件/表格等能力，恢复单条插件即可；全部恢复可用备份文件整体还原。

## 相关

- [2026-10-25-2-ide-remote-workspace-key-dedup.md](./2026-10-25-2-ide-remote-workspace-key-dedup.md)
- [../development/ENVIRONMENT.md](../development/ENVIRONMENT.md)（进程盘点方法）
