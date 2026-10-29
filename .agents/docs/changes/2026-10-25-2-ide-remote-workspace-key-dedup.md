# 2026-10-25 · 修正远控桥 workspaceKey，消除同一项目的重复 agent

- **范围**：`vendor/ZCode/packages/ide-remote-bridge/`（插件自有包，不计入官方补丁预算）
- **触发**：bug——IDE 启动后任务管理器里同一项目出现两套 agent 进程树（约 8 个进程 / 930 MB）
- **提交**：vendor fork `b177da31`（ide-integration）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/ide-remote-bridge/src/workspace-keys.ts` | 新增 | key 判定的唯一出口：`normalizeWorkspaceKey`（仅比较用）、`workspaceKeyMatches`、`dedupeWorkspacePaths`、`resolveWorkspaceTarget` |
| `packages/ide-remote-bridge/src/device.ts` | 修改 | 项目列表保留 server 原始 `rootPath`；下发与 `workspace-bridge-ready` 一律使用该原始路径；local target 不再下发 `workspaceIdentity`；bootstrap 的默认工作区按归一化比较 |
| `packages/ide-remote-bridge/src/terminal-probe.ts` | 修改 | 默认 key 从 `workspaceIdentity` 改为 `workspacePath`，与新的列表契约一致 |
| `packages/ide-remote-bridge/test/workspace-keys.test.ts` | 新增 | 5 个回归测试：正/反斜杠匹配、identity 匹配、解析返回原始写法、去重保留原始写法、归一化不改变下发值 |
| `packages/ide-remote-bridge/package.json` | 修改 | 新增 `test` 脚本（`node --experimental-strip-types --test`） |

## 为什么改

server 判定工作区的函数 `resolveWorkspaceKey`（`packages/shared/src/task-realtime-core.ts:84`）是
**字面字符串**：`workspaceIdentity?.trim() || workspacePath`，不做任何路径规范化。agent 进程按这个
字符串一对一派生。

问题是同一个目录被两种写法同时使用：

- IDE 面板：`web-ide/src/main.tsx` 的 `bindWorkspaceProject()` 使用 server 规范化后的路径，
  Windows 下是反斜杠（`E:\work\zcode-ide`）；
- 远控桥：`readProjectWorkspaces()` 把 `projectService.readTree()` 的 `rootPath` 转成正斜杠后
  作为手机端的 `workspacePath` 下发，手机回传 `E:/work/zcode-ide`，桥又按请求原值打开。

于是 server 认为这是两个工作区，各起一套 agent。日志可以直接对上：

```
pid 14780  workspaceKey: 'E:\work\zcode-ide'   ← IDE 面板
pid 4044   workspaceKey: 'E:/work/zcode-ide'   ← 手机远控
```

被否决的方案：

- 在 server 侧做 key 规范化：属于官方原有文件，补丁预算已满，且会影响桌面端与远程宿主的身份语义。
- 在 Kotlin 侧统一路径：Kotlin 拿不到 server 的 `rootPath`，只是把问题挪了个位置。

## 行为变化

- 手机端拿到的工作区列表使用 server 原始写法（Windows 反斜杠），不再带 `workspaceIdentity`；
  `workspace-bridge-ready` 返回的 `workspaceKey` 也是该原始写法，与 IDE 面板完全一致。
- 手机回传正斜杠、反斜杠、大小写不同或带尾斜杠的 key 仍能匹配（归一化只用于比较），但打开时
  一律落到原始写法，因此复用 IDE 面板已经拉起的 agent。
- 桥要求的 `--workspace-identity` 参数保留，但不再参与工作区列表与 key 生成。

## 验证

1. 回归测试（真实源码路径，Node 24 类型擦除）：
   `node --experimental-strip-types --test test/workspace-keys.test.ts` → 5 passed。
2. 端到端（不影响运行中的 IDE 桥）：用临时 `--device-mid` / `--state-file` 启动新桥，
   `terminal-probe` 模拟手机以 `PROBE_WORKSPACE_KEY=E:/work/zcode-ide` 发起 `workspace-bridge-open`：
   - `workspace-list-response` 返回 `E:\work\zcode-ide`（原始写法），16 个项目全部为本机路径；
   - `workspace-bridge-ready` 的 `workspaceKey` 为 `E:\work\zcode-ide`；
   - forwarded RPC（`settingService.get`）正常返回；
   - 验证窗口内 `idea.log` 的 `ZCode agent process started` 计数为 0，说明没有再派生 agent。
   验证结束后已停止临时桥并从 relay 删除临时设备。
3. 构建链：`pnpm --filter @zcode/ide-remote-bridge build` → `node scripts/build-runtime.mjs`
   → `./gradlew buildPlugin`（JDK 21）全部通过；zip 内
   `zcode-ide/runtime/remote-bridge/index.mjs` 已包含新逻辑。
4. **真机部署验证（2026-10-25 重启 IDE 后）**：开 zcode-ide / <your-bucket> / ezllm 三个项目窗口，
   日志中本会话 agent 的 workspaceKey 全部为规范写法（`E:\work\zcode-ide`、`E:\work\<your-bucket>`、
   `E:\work\ezllm`），无 `E:/` 变体；`terminal-probe` 以正斜杠 key 访问正式桥，ready 返回规范 key、
   RPC 正常、新增 agent 计数 0——面板与手机命中同一 agent。
5. 进程账本：修复前同样的 3 窗口是 5 个 agent（两对重复）；修复后 3 个 agent（3 个项目各一），
   本插件共 5 个 node（当时插件宿主还在，见
   [变更记录 3](./2026-10-25-3-ide-plugin-mcp-disabled.md) 的进一步压缩）。

遗留未验证：

- 手机真机完整 UI 的逐项回归（任务列表/切换项目/发消息）在本次修复前已由用户确认可用（"可以了"），
  修复后未再逐项复测；
- 手机端若缓存了修复前的 `workspaceIdentity` 并直接用它打开工作区，会匹配失败，重新拉一次
  工作区列表即可恢复（IDE 宿主下 `initialWorkspaceIdentity` 本来就为空，影响面很小）。

## 风险 / 后续

- agent 空闲不回收是上游设计（`idleTimeoutMs` 只作用于 mcp-status 通道），手机上切换过几个项目
  就会常驻几套 agent。要压缩内存，下一步可以做"远控桥关闭且没有本地面板时，向 server 请求
  释放该工作区 agent"，避免长期占用；未在本次改动中处理。
- 整次 IDE 重启会在 relay 遗留一个离线旧设备（同 `deviceMid` 换新 `sid`），远控链接随之变化；
  这是"设备列表堆积无用设备"的来源之一，可做启动时清理/复用，未在本次改动中处理。

## 相关

- [2026-10-25-ide-web-remote-control.md](./2026-10-25-ide-web-remote-control.md)
- [../architecture/PROJECT-MAP.md](../architecture/PROJECT-MAP.md)
- [../development/INVARIANTS.md](../development/INVARIANTS.md)
