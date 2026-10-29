# 2026-10-29 · 安装器权限不足时自动 UAC 提权强杀

- **范围**：`scripts/npm/lib/processes.mjs`、测试、README
- **触发**：用户提出两点 —— ① 需要管理员权限时能否提示用户；② 机器上 PS1 脚本执行被禁用怎么办
- **提交**：working tree

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/lib/processes.mjs` | 修改 | 新增 `isWindowsElevated` / `elevationHint` / `isAccessDeniedOutput` / `buildElevatedKillScript` / `encodePowerShellCommand` / `runElevatedKill`；关闭 IDE 被拒（拒绝访问）时自动 UAC 提权强杀；残留进程清理与强制结束也会在权限不足时提权；提权脚本排除安装器自身 pid；提权失败给出管理员终端指引 |
| `scripts/npm/test/processes.test.mjs` | 修改 | 新增 3 个用例：拒绝访问输出识别（中英文）、提权检测输出与提示文案、内联脚本转义与 EncodedCommand 往返 |
| `scripts/npm/README.md` | 修改 | 「进程与目录占用」补充自动提权与执行策略说明 |

## 为什么改

IDE 以管理员身份启动时，普通终端 `taskkill` 返回「拒绝访问」。原实现只会等到超时，最后抛
一句"请手动退出后重试"，用户不知道是权限问题。

两个设计取舍：

1. **提前检测 + 明确提示**：`isWindowsElevated()` 用 `IsInRole(Administrator)` 判断当前终端
   权限；不是管理员就先提示"如果 IDE 以管理员身份启动将无法关闭"。
2. **用 `-EncodedCommand` 而不是 .ps1 文件**：`-ExecutionPolicy Bypass` 在组策略
   （MachinePolicy）下会被忽略，Restricted 机器上根本无法执行脚本文件。把强杀逻辑内联成
   base64（UTF-16LE）传给 PowerShell，属于"命令"而非"脚本文件"，不受执行策略限制。
   提权本身仍走 `Start-Process -Verb RunAs`（弹 UAC）。
3. **按需提权，不默认弹窗**：只有 taskkill 明确返回"拒绝访问"、或残留进程清理失败时才弹
   UAC，正常安装不会打扰用户。
4. **排除安装器自身 pid**：提权脚本是独立进程，拿不到"我是谁"，而安装器自己的 node 进程
   命令行里也可能出现插件目录（例如 `--zip`/`--target` 传了完整路径）。实测第一版提权脚本
   把测试进程自己一起杀掉了（结果文件没写完），因此给脚本加了 `excludePids`，由
   `runElevatedKill` 传入 `process.pid`。

## 行为变化

- 权限不足时：弹出 UAC 窗口（提示"正在请求管理员权限"），确认后强杀 IDE 进程树与占用插件
  目录的 node 残留进程；成功则继续安装。
- 取消 UAC / 提权失败：明确提示用"以管理员身份运行"的终端重试。
- 用户显式拒绝提权不会导致安装静默失败——会走原有报错路径并带上管理员提示。
- 非 Windows 平台行为不变。

## 验证

- `npm test`（`scripts/npm`）：98 个用例全绿（新增 4 个：拒绝访问识别、提权提示、内联脚本
  转义与编码往返、自身 pid 排除）。
- 执行策略回归实测：构造占用 `plugins/zcode-ide` 的 node 进程（pid 7732），用
  `buildElevatedKillScript` + `encodePowerShellCommand` 生成命令，在
  `powershell -ExecutionPolicy Restricted` 下执行 → 退出码 0，复查进程列表为空。
  这证明"内联命令不受脚本执行策略限制"的假设成立。
- **真实 UAC 路径实测**：独立占位进程 pid 13644 → `runElevatedKill({pluginDirs})` →
  UAC 确认后脚本返回 `elevated=true`，复查 `after=[]`（占位进程已清）；调用方进程（self=19064）
  存活并写完了结果文件，确认自身排除生效。
- 未验证：管理员权限启动的真实 IDE 下的端到端安装。

## 风险 / 后续

- 若机器用 AppLocker/WDAC 直接禁止 `powershell.exe`，提权路径不可用；此时会退回手动指引。
- UAC 弹窗对完全无人值守的静默安装不友好；如需完全静默，应预先以管理员终端运行。
- 需要发新版本（0.0.7）才能让远端机器用上这一批进程/权限修复。

## 相关

- [`2026-10-29-11-installer-kill-process-tree.md`](./2026-10-29-11-installer-kill-process-tree.md)
- `scripts/npm/README.md` 「进程与目录占用」
