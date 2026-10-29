# 2026-10-25 · 复审加固：远控桥异常兜底、并发串行化与类型检查门槛

- **范围**：`vendor/ZCode/packages/ide-remote-bridge/`（插件自有包）、插件 Kotlin、`scripts/`、文档
- **触发**：对工作区未提交代码的整体复审（远控桥功能 + workspaceKey 去重修正之后）发现的问题，当场修复
- **提交**：vendor fork `b177da31`（ide-integration）+ 插件仓库同批提交

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/ide-remote-bridge/src/device.ts` | 修改 | ① `onPayload` 增加 `.catch` 兜底：Node 24 对 unhandled rejection 默认直接退出进程，一条 payload 的未预期异常不能再杀掉整个桥。② `workspace-bridge-open` 改走 `openChain` 串行队列：并发 open 时后一个若落在前一个 `connectLocalServer` 期间，会覆盖 `this.bridge` 并泄漏先建立的一套本地 WS 与监听器 |
| `packages/ide-remote-bridge/src/server-link.ts` | 修改 | rpc 导入从相对路径改为包名 `@zcode/rpc`：tsc 按 exports 的 `types` 条件消费 rpc dist 声明产物（rpc 自身 tsconfig 不继承 base，直接检查其源码会互相报错）；esbuild 走 `default` 条件仍解析到同一份 `src/index.ts`，产物不变（实测仍 1.7MB） |
| `packages/ide-remote-bridge/package.json` | 修改 | 新增 `typecheck` 脚本（用仓库根 typescript，与 build.mjs 用根 esbuild 同一模式）；声明 `@zcode/rpc: workspace:*` 依赖 |
| `packages/ide-remote-bridge/tsconfig.json` | 新增 | extends base + noEmit 的独立类型检查；不进根 typecheck 的 `tsc -b` 清单（本包非 composite，跨包源码导入在 composite 下被 TS6307 禁止；根 typecheck 脚本属官方 package.json，补丁预算已满不改它） |
| `packages/ide-remote-bridge/src/shims.d.ts` | 新增 | `declare module "node-forge"`：上游 services 对 node-forge 本就是隐式 any，桥的类型检查会把 services 源码连带进来，显式补齐同一语义，避免连带误报 |
| `src/main/kotlin/dev/zcode/ide/remote/RemoteControlBridge.kt` | 修改 | `status()` 从独立 `lock` 对象改为 `@Synchronized`（this）：此前读写用两把不同的锁且字段非 volatile，理论上可读到过期状态 |
| `scripts/ci-build.mjs` | 修改 | ① 补 `pnpm --filter @zcode/ide-remote-bridge build`——桥不在 cli/server/web-ide 任一构建目标的依赖闭包里，漏掉则 build-runtime 的 `must()` 必失败（复审发现的 CI 阻塞项）。② 补 `typecheck` 步骤（放在构建之后：tsconfig 消费 rpc dist 声明，依赖 cli 构建先产出） |
| `vendor/ZCode/pnpm-lock.yaml` | 修改 | importers 补 `packages/ide-remote-bridge`（`@zcode/rpc` link 条目；pnpm 10.33 frozen 可自愈，落库防各机漂移；不计补丁预算） |
| `AGENTS.md`、`CHANGES-VS-UPSTREAM.md`、变更记录 1 | 修改 | 文档过期项修正：桥能力 12→15；CHANGES-VS-UPSTREAM 头部 fork HEAD `f2f72b14`→`cf345dcb`、提交数 7→8、§2 补 `cf345dcb` 行、DesktopTopOverlay 注释方向反了（该还原已提交，未提交的是 `WorkspaceSidebarFooter.tsx`，HEAD 口径 22 / 工作区 23）、新增文件 13→15 |

## 为什么改

- **CI 阻塞**：`build-runtime.mjs` 强制要求桥的 dist，但 `ci-build.mjs` 从未构建它——fork 提交、锁更新全部就绪后 CI 仍会在组装 runtime 时失败。
- **进程存活**：远控桥是常驻进程，官方 app-payload 层的 `bootstrap-response` 只有 `success: true` 一种形态（无 error 变体可回），失败时唯一正确行为是记日志让手机端超时重试，进程本身必须活着。
- **类型门槛空白**：桥包与 web-ide 此前只有 esbuild/vite 转译，没有任何类型检查；契约漂移（字段名、返回形状）只能靠运行时暴露。桥包现在有独立 tsconfig + CI 步骤。

## 行为变化

- 桥进程不再因单条 payload 的未预期异常退出；手机快速连续切换工作区不再泄漏本地连接；IDE 侧状态读取与启动/停止所见一致。
- CI（打 tag 后）从"必挂"恢复为可产出：桥构建与类型检查入链。
- 桥包 import rpc 的方式变化对产物零影响（同一份源码）。

## 验证

已执行：

1. `pnpm --filter @zcode/ide-remote-bridge typecheck` 全绿（覆盖 device/terminal-probe/index 全图，连带 shared/client/desktop 源码按 base 口径检查）。
2. `pnpm --filter @zcode/ide-remote-bridge build` 产出 1.7MB，与改前一致；`test` 5/5 通过。
3. `./gradlew compileKotlin`（JDK 21）通过。
4. `node scripts/patch-budget.mjs --worktree`：23 修改 / 23 预算、新增 15。
5. `pnpm install --frozen-lockfile --ignore-scripts` 通过（确认 lock 自洽）。

未验证：

- 真机远控回归（本轮只动异常路径、并发保护与类型检查；主链路行为由[变更记录 1](./2026-10-25-ide-web-remote-control.md)、[2](./2026-10-25-2-ide-remote-workspace-key-dedup.md)的验证覆盖）。
- 完整 `buildPlugin` + 部署链未重跑（compileKotlin 与桥构建已覆盖本轮改动的编译面）。

## 风险 / 后续

- **typecheck 消费 rpc dist 声明**：本地 rpc dist 过期时检查的是旧声明（CI 全新构建无此问题；本地改 rpc 源码后需重建 rpc）。
- **`normalizeWorkspaceKey` 无条件转小写**：大小写敏感文件系统（Linux）上仅大小写不同的两个项目会被误判为同一个。当前插件仅面向 Windows，保持现状；若上 Linux 需按平台分流。
- **web-ide 仍无类型检查**（vite build 不查类型、无 tsconfig）；可照本包模式补，未在本次处理。

## 相关

- [2026-10-25-ide-web-remote-control.md](./2026-10-25-ide-web-remote-control.md)
- [2026-10-25-2-ide-remote-workspace-key-dedup.md](./2026-10-25-2-ide-remote-workspace-key-dedup.md)
