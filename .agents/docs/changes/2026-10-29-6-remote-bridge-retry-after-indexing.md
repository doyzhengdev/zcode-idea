# 2026-10-29 · 远控自动恢复改为索引结束时补试

- **范围**：插件 Kotlin（`remote/RemoteControlAutoStart.kt`）
- **触发**：bug —— 上一轮给启动活动加 `DumbAware` 后暴露的健壮性缺口
- **提交**：working tree

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/main/kotlin/dev/zcode/ide/remote/RemoteControlAutoStart.kt` | 修改 | 恢复流程拆成 `restore()` / `retryAfterIndexing()` / `attemptRestore()`；新增 `restoring` 并发闸与 30s 最小间隔；启动活动订阅 `DumbService.DUMB_MODE`，在 `exitDumbMode` 时补试 |

## 为什么改

`RemoteControlStartupActivity` 在上一轮被标记为 `DumbAware` 后，远控自动恢复从"索引结束后"提前到"索引进行中"执行。它的重试窗口是固定的 `8s + 6 × 10s ≈ 68s`，一旦全部落在 dumb mode 内（索引抢占 CPU、runtime 未就绪、依赖缺失等），就会打印 `Auto-restore ZCode remote bridge gave up after 6 attempts` 并**永久停止**，本次 IDE 会话的远控再也不会恢复，用户也收不到提示。

日志实证（`idea.log`）：

```
15:15:27  Reusing ZCode server port 49525 / Starting ZCode server   ← 第 1 次
15:16:11  ... (每 10s 一次)                                          ← 第 6 次
15:16:21  Auto-restore ZCode remote bridge gave up after 6 attempts
```

当时的直接诱因是 `vendor/ZCode/node_modules` 缺失（`ERR_MODULE_NOT_FOUND: yauzl`），但缺依赖只是放大器：任何"启动期暂时起不来"的场景（下载 runtime、磁盘慢、索引抢占）都会踩到同一个坑。

## 行为变化

- 索引结束（`exitDumbMode`）时，如果远控意图存在且桥未运行，补做一轮恢复；失败后下一次索引结束还会再试，不再"一次失败即永久放弃"。
- 补试与初始循环共用一个 `AtomicBoolean` 闸，且两次尝试间隔不小于 30s，避免重复拉起桥进程。
- 用户显式关闭远控（`readEnabledIntent()` 为空）时不触发；桥已运行时立即返回，开销可忽略。
- 成功路径（启动即能连上）行为不变。

## 验证

- `JAVA_HOME=<jdk21> ./gradlew buildPlugin --console=plain` → `BUILD SUCCESSFUL in 7s`。
- 安装后重启的正常路径待验证（计划：重启 IDE，确认 `Auto-restored ZCode remote bridge` 正常打印、无新增告警）。
- 失败路径（初始 6 次全失败 → 索引结束后补试成功）**未做故障注入**，仅代码审查；如需实测可临时重命名 `vendor/ZCode/node_modules/yauzl` 并触发一次冷索引。

## 风险 / 后续

- 若 server 长期不可用，每次 dumb mode 结束都会尝试一次恢复（受 30s 间隔约束），日志会周期性出现 `Retry ZCode remote bridge after indexing failed`，属预期。
- 订阅挂在项目 messageBus 上，以 `Project` 作为 disposable，项目关闭自动取消；多窗口会各订阅一份，但应用级闸保证只有一个在跑。

## 相关

- [`2026-10-29-5-ide-toolwindow-dumb-aware.md`](./2026-10-29-5-ide-toolwindow-dumb-aware.md)（本轮 `DumbAware` 改动）
- [`INVARIANTS.md`](../development/INVARIANTS.md) 第 25 条
