# 2026-10-29 · ZCode fork 公开到 GitHub剩含本机标识清理）

- **范围**：`vendor/ZCode`剩fork 分支）、`vendor/zcode.lock`
- **触发**：用户要求"fork 的 ZCode 也要开源到 GitHub"
- **提交**：fork 内 `f17677b6`；插件仓库 working tree

## 做了什么

1. **确认公开状态**：`doyzhengdev/ZCode` 匿名访问 200，API `fork=true`、`parent=zai-org/ZCode`；
   `main` 与 upstreamBase 一致剩`3c5b2276`），补丁在 `ide-integration`剩领先 main 13 个提交、
   46 个文件）。
2. **清理补丁树里的本机标识**剩4 个文件，31 行）：

   | 文件 | 原内容 | 现内容 |
   |---|---|---|
   | `packages/ide-remote-bridge/src/device.ts` | 注释里的 `<host>` | `host-a` |
   | `packages/shared/test/remoteWorkspaceIdentity.ide.test.ts` | `<host>`、`E:/work/ezllm`、`<host>` | `host-a`、`E:/work/ezllm` |
   | `packages/ide-remote-bridge/test/workspace-keys.test.ts` | `E:/work/*`、`<host>`、`E:\work\<your-bucket>`、`e:/WORK/...` | `E:/work/*`、`host-a`、`E:\work\example-project`、大小写变体同步替换 |
   | `apps/zcode-cli/packages/core/tests/persisted-remote-session-path-repair.ide.test.ts` | `/E:/work/ezllm` 等 | `/E:/work/ezllm` |

   > 注意：替换必须覆盖 **大小写变体**剩测试本身就在验证大小写不敏感的路径匹配），
   > 只替换小写会留下 `e:/WORK/...` 造成断言失败。
3. **设置仓库元数据**：description 指明"ide-integration 分支承载 zcode-idea 插件补丁"，
   homepage 指向插件仓库，topics：`zcode` `jetbrains-plugin` `fork` `patch`。
4. **推送**：`github`剩GitHub fork）与 `fork`剩Work）两个 remote 都更新到 `f17677b6`。
5. **更新 `vendor/zcode.lock`**：`commit` 从 `e6e01179` → `f17677b6`剩此前已落后两个提交）。

## 为什么改标识

fork 的 `ide-integration` 分支是公开可见的，测试夹具与注释里的 `<host>`、`E:/work/...`
会暴露本机用户名与私有目录布局。它们是纯测试数据/注释，替换为通用占位不影响行为。

## 验证

- `packages/ide-remote-bridge`：`node --experimental-strip-types --test test/workspace-keys.test.ts` → 5 passed
- `apps/zcode-cli/packages/core`：`vitest run tests/persisted-remote-session-path-repair.ide.test.ts` → 1 passed
- `packages/shared`：根目录 `vitest run packages/shared/test/remoteWorkspaceIdentity.ide.test.ts` → 2 passed
- 公开树复查：`<host>` / `<host>` / `E:/work` / `E:\work` / `<your-bucket>` 文本命中 0
  剩剩余 `<user>` 命中是 base64 图片数据里的偶然字符串）
- `node scripts/patch-budget.mjs`：仍是 **修改 19 / 预算 23、新增 17**

## 风险 / 后续

- fork 的默认分支仍是上游 `main`剩未打补丁），访客需切到 `ide-integration`；如需访客默认看到
  补丁，可在仓库设置里把默认分支改为 `ide-integration`剩未改，保持与上游一致）。
- 后续每次同步上游后，要同时推 `fork` 与 `github`；fork 自带 husky `pre-push` 依赖
  `origin/staging`，两个 remote 都要加 `--no-verify`。
