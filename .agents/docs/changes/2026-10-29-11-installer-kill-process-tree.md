# 2026-10-29 · 安装器改为树杀并清理占用插件目录的残留进程

- **范围**：`scripts/npm`（进程关闭逻辑、安装流程、测试、README）
- **触发**：bug —— 部分机器上安装器没能结束 IDE；另有 node 进程占用 `plugins/zcode-ide` 导致安装失败
- **提交**：working tree

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/lib/processes.mjs` | 修改 | 优雅关闭与强制结束都加 `/T`（Windows 连子进程）；强制结束优先按 pid 树杀并输出 taskkill 失败原因；新增 `listPluginDirHolders` / `killPluginDirHolders` / `commandLineReferencesDirs` / `parseWindowsProcessJson` / `isDirectoryLockedError` |
| `scripts/npm/bin/zcode-idea.mjs` | 修改 | 关闭 IDE 后清理占用插件目录的残留进程；解压遇 `EBUSY/EPERM` 时清理一次再重试 |
| `scripts/npm/test/processes.test.mjs` | 新增 | 4 个用例：路径匹配（`\`/`/`、大小写、尾部斜杠）、Windows 进程 JSON 解析、目录占用错误识别 |
| `scripts/npm/README.md` | 修改 | 新增「进程与目录占用」：说明自动清理逻辑与手动强制结束命令 |

## 为什么改

两个独立问题：

1. **有的机器没被强制结束**：原实现 `taskkill /IM <name>` 既没有 `/T` 也没有按 pid 重试，
   遇到 IDE 有别名的进程（`idea.exe` / `idea64.exe`）或权限不足时静默失败，也没有把
   taskkill 的错误输出打出来。现在强制结束按 pid `/F /T`，失败会明确提示"若 IDE 以管理员
   身份运行，请用管理员终端重试"。
2. **node 进程占用插件目录**：IDE 会派生 ZCode server（`runtime/server/dist/entry-http.js`）、
   agent（`zcode.cjs`）与远控桥，父进程被结束后它们常变成孤儿，继续持有
   `plugins/zcode-ide` 下的 jar / runtime。Windows 上表现为删除目录或解压报 `EBUSY/EPERM`，
   安装直接失败。现在关掉 IDE 后会按"命令行引用了该插件目录的 node 进程"精确清理，
   解压失败时还会再清一次并重试。

## 行为变化

- 关闭 IDE 是树杀：子进程（含 ZCode node 进程）一并结束，不再留孤儿。
- 安装过程会输出残留进程清理日志（仅当发现占用者）。
- 解压失败不再直接报错退出，会尝试清理 + 重试一次；仍失败才报原错误。
- 非 Windows 平台行为不变（仍用 SIGTERM/SIGKILL）。

## 验证

- `npm test`（`scripts/npm`）：93 个用例全绿（新增 4 个）。
- 真实功能验证：起一个 command line 引用
  `.../holder-test/plugins/zcode-ide/fake-entry.js` 的 node 进程，调用
  `killPluginDirHolders(['.../holder-test/plugins/zcode-ide'])` →
  日志"检测到 1 个进程仍占用插件目录 → 已结束占用插件目录的残留进程"，复查进程列表为空。
- 未验证：真实 IDE 场景下的树杀（需要关闭本机 IDE），以及管理员权限不足时的提示文案。

## 风险 / 后续

- 清理按"命令行包含插件目录"匹配，只会命中 node/zcode 宿主进程；不影响同机其它 node 服务。
- 需要发新版本（0.0.7）才能让远端机器用上；在那之前可按下节手动命令处理。

## 相关

- `scripts/npm/README.md` 「进程与目录占用」
- [`2026-10-29-10-release-0-0-6-full-package.md`](./2026-10-29-10-release-0-0-6-full-package.md)
