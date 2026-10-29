# CI 与发布流水线

目标：**fork 改动 → 一条命令 → 可安装的插件 zip**。fork 只当构建输入，`zcode-ide` 是唯一产出插件包的地方。

## 1. 单入口脚本

```bash
node scripts/ci-build.mjs
```

它按顺序做：

1. 读 `vendor/zcode.lock`，把 fork clone/fetch 到 `.ci/ZCode` 并 checkout 锁定 commit（已设置 `ZCODE_REPO` 时直接复用）；
2. `node scripts/bootstrap.mjs --check --no-link` 校验 HEAD 与锁一致；
3. `node scripts/patch-budget.mjs` 校验补丁面不超过锁里的 `patchBudget.maxModified`（口径与 rebase 关注点见 [`ZCODE-UPSTREAM-SYNC.md`](../upstream/ZCODE-UPSTREAM-SYNC.md) 的「补丁预算」）；
4. `pnpm install --frozen-lockfile`；
5. 构建 `@zcode/cli...` → `@zcode/server` → `@zcode/web-ide`（与 fork 自带 `build:zcode` 的顺序一致）；
6. 严格锁模式跑 `scripts/build-runtime.mjs`，校验 `dist/BUILD-INFO.json`；
7. `gradlew buildPlugin`；
8. 打印 zip 路径、大小和 sha256。

常用参数：

| 参数 / 环境变量 | 用途 |
|---|---|
| `--skip-install` | 复用已有 `node_modules`（本地演练/CI 缓存命中时） |
| `ZCODE_REPO` | 直接使用现成 fork（不 clone），本地演练用 |
| `ZCODE_WORK_DIR` | 覆盖默认工作目录 `.ci/ZCode` |
| `ZCODE_FORK_REPO` | 覆盖锁里的 clone 地址（镜像/私有部署） |

## 2. GitHub Actions

工作流在 [`.github/workflows/build-plugin.yml`](../../.github/workflows/build-plugin.yml)，触发方式是手动 `workflow_dispatch` 和 `v*` tag。缓存了三样东西：

- pnpm store（`pnpm store path`）
- Gradle caches + `.intellijPlatform`
- `.ci`（fork 工作副本 + `node_modules`）

缓存键是 `runner.os + hash(vendor/zcode.lock)`，所以一次发版只会在锁变化时重装。

## 3. Work Go / 自托管 runner

仓库主源在 Work 时，不需要为 Work Go 重写构建逻辑——流水线只调用 `node scripts/ci-build.mjs`，runner 满足下面条件即可：

- Windows runner（必需，原因见第 5 节）
- Node ≥ 24、pnpm 10、JDK 21（`JAVA_HOME`）
- git

Work Go 的 `stages` 里放两步即可：`pnpm/action-setup` 的等价物（预装或用 corepack）→ `node scripts/ci-build.mjs` → 上传 `build/distributions/*.zip`。自托管 runner 更简单，直接跑脚本。

## 4. fork 仓库的“体检”流水线（可选）

fork push 时只需要跑：

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm exec vitest run packages/ui/src/project-sidebar/activity
pnpm --filter @zcode/web-ide build
pnpm --filter @zcode/server build
pnpm --filter "@zcode/cli..." build
```

只验证 fork 自身能否编译，不产出插件包。跨仓库触发（fork push → 通知插件仓库构建）可以用 GitHub `repository_dispatch` 或 Work webhook；如果嫌麻烦，定时或发版时手动触发也够用。

## 5. 必须在 Windows 上构建

`scripts/build-runtime.mjs` 会调用 fork 的 `copyRuntimeNodeModules` 和 `patchNodePtyPrebuilds` 拷贝原生依赖闭包。这些预编译模块是平台相关的，Linux 上构建出的 zip 在 Windows IDE 里会缺模块。目标产物是 Windows 插件，就固定用 Windows runner。

## 6. 发版顺序（重要）

1. 在 fork 提交改动；
2. 在插件仓库执行 `node scripts/patch-budget.mjs` 核对补丁面，更新 [`CHANGES-VS-UPSTREAM.md`](../upstream/CHANGES-VS-UPSTREAM.md)，再执行 `node scripts/bootstrap.mjs --update` 把新 commit 写进 `vendor/zcode.lock`；
3. 提交插件仓库（含锁与文档）；
4. 打 `v*` tag 触发流水线。

如果跳过第 2 步，CI 会按旧 commit 构建，产物缺少新提交——`BUILD-INFO.json` 和脚本的锁校验都会暴露这一问题。
