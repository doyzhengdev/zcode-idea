# ZCode fork 上游同步指南

> 创建：2026-10-24。背景：官方 ZCode（`zai-org/ZCode`）持续更新，我们的 fork（`ide-integration` 分支）承载插件必需的源码补丁。本文记录仓库拓扑、补丁清单与同步流程，官方发版后照此操作即可。

## 1. 仓库拓扑

| 仓库 | 地址 | 用途 |
|---|---|---|
| 官方上游 | `https://github.com/zai-org/ZCode.git` | 更新来源，直连不稳定，**一律走代理** |
| 上游代理 | `https://ghfast.top/https://github.com/zai-org/ZCode.git` | 实测可用；备选 `https://gh-proxy.com/...` |
| Work 备份 | `https://github.com/zai-org/ZCode.git` | 我们的 fork 托管地，push 目标 |
| GitHub fork（公开） | `https://github.com/doyzhengdev/ZCode` | 官方仓库的公开 fork（出现在官方 Forks 列表与 network 图），承载 `ide-integration` |
| 本地工作副本 | `E:\work\doyzheng\zcode-ide\vendor\ZCode` | 独立 git 仓库（被插件仓库 gitignore），构建 `runtime/` 的源 |

本地 remote（实际配置）：

- `fork` → Work 备份（push 目标）
- `github` → GitHub 公开 fork（push 目标）。fork 自带 husky `pre-push` 钩子依赖
  `origin/staging` 基线，从本工作副本推送会失败，需加 `--no-verify`：
  `git push --no-verify github ide-integration:refs/heads/ide-integration`
- 拉官方更新时按上表"上游代理"地址临时 fetch，不建常驻 `upstream`；GitHub 上的 fork 关系
  （Forks 列表、network 图）由 GitHub 自己维护，与本地 remote 名无关。

> GitHub 的 fork 网络只认 **GitHub 上**的 fork：Work 的 fork 不会出现在
> `github.com/zai-org/ZCode/forks` 或 network 图里。

旧副本 `E:\work\ZCode` 已由本仓库取代，仅作过渡备份，确认无误后可删除。

## 2. 分支模型

- `main`：跟随官方，不含任何本地改动（用于比对与 rebase 基线）。
- `ide-integration`：官方 main + 我们的全部补丁（线性 rebase，补丁始终在顶端）。**zcode-ide 插件构建用的是这个分支。**
- tags：随上游全量同步。

## 3. 我们的补丁清单（当前 7 个提交，2026-10-25）

> 完整的逐文件记录（改了什么、为什么必须在官方源码、冲突风险）见 [`CHANGES-VS-UPSTREAM.md`](./CHANGES-VS-UPSTREAM.md)。本节只给 rebase 时的快速索引。

同步冲突高发区，rebase 时重点看这些文件：

| 提交 | 内容 | 涉及文件 |
|---|---|---|
| `60ffe5db` fix(server) | 旧任务行 `workspace_identity` 补全 + Windows 盘符/会话路径自愈（`E:\E:\`） | `server/src/legacy-remote-tasks.ts`（新增）、`entry-http.ts`；`shared/src/remote-workspace-identity.ts` + 测试；`cli/.../persisted-remote-session-path-repair.ts` + 测试 |
| `7aae0cc7` fix(ui) | composer scope 解析与最近使用模型播种 | `ui/lib/composerRecent.ts`、`ui/v4/composer/useDraftConfigControl.ts` |
| `5f6d3803` feat(ui) | `ideHost=1` 门控的界面精简、新建任务修复 | `ui/lib/ideHost.ts`（新增）、`project-sidebar/index.tsx`、`WorkspaceHeader*`、`DesktopTopOverlay.tsx`、`WorkspaceShellLayout.tsx`、`App.tsx`、`SessionPane.tsx`、`useRootWorkspaceActions.ts`（其中 `ProjectSidebarListHeader`/`ProjectSidebarNavigation` 已被 `f2f72b14` 还原） |
| `f07cd1cf` feat(web-ide) | 自建 IDE 版 Web 入口（上游没有这个包，不会冲突） | `packages/web-ide/*` 全部、`pnpm-lock.yaml` |
| `261fa358` feat(server) | 独立 server 改 local 宿主形态 | `server/src/entry-http.ts`、`web-ide/src/main.tsx`——rebase 时优先保留我们的 local 装配 |
| `eded5be9` feat(ui) | 点文件统一进 IDE 编辑器、行号列号透传、MCP 与另存为桥 | `ui/hooks/useAppPanels.ts`、`ui/lib/ideFileOpen.ts`（新增）、`shared/src/platform.ts`、`ui/lib/codeViewer.ts`、`ui/components/ai-elements/message.tsx`、`SettingsPage.tsx`、`WorkspaceShellLayout.tsx`、`App.tsx`、`web-ide/*` |
| `f2f72b14` refactor(ui) | 侧栏隐藏改由 CSS 承接、sessions 事件驱动自愈 | `ui/project-sidebar/index.tsx`、`ui/v4/sessionsIndexStore.ts`、`ui/v4/useWorkspaceSessionsIndexItems.ts`、`web-ide/src/styles.css`；还原两个 sidebar 文件 |

取舍准则：病灶在官方 UI 的 React 初始化路径或 server 任务表写入逻辑时必须改源码（插件侧只能 `executeJavaScript` 注入 DOM，改不了组件初始化，也无法在 server 启动前改 SQLite）；能放进 `ServerProcess.kt` 的就不动源码。UI 增删一律走 `isIdeHost()` 门控，保住桌面端行为与官方 e2e。

### 3.1 补丁预算（同步时必看）

策略：**不向上游提 PR**，由我们自己 `git fetch upstream` 后 rebase/merge 到 `ide-integration` 并推回 Work。因此补丁面直接等于每次同步的冲突成本，必须控制。

```bash
node scripts/patch-budget.mjs            # 已提交 HEAD（CI 口径）
node scripts/patch-budget.mjs --worktree # 含未提交改动
```

当前（锁 commit `f2f72b14`，基线 `3c5b2276`）：

| 指标 | 数值 |
|---|---|
| 修改的官方源码文件 | 23 / 预算 23（已卡满，再改官方源码须先显式上调预算） |
| 新增（零冲突） | 3 |
| 排除 | 9（`packages/web-ide` 8 + `pnpm-lock.yaml`） |
| 通用改动（无显式 IDE 门控） | 9 |

预算写在 `vendor/zcode.lock` 的 `patchBudget.maxModified`，`ci-build.mjs` 会强制执行。新增 fork 补丁时先问：能不能用 web-ide CSS / platform / 运行时注入承接？都不行才改官方源码，并显式上调预算。

rebase 时重点核对（通用改动，最容易与上游重构撞车；以脚本输出为准）：

- `apps/zcode-cli/.../persisted-remote-session-path-repair.ts` + 测试
- `packages/server/src/entry-http.ts`
- `packages/shared/src/remote-workspace-identity.ts` + 测试
- `packages/ui/src/lib/composerRecent.ts`
- `packages/ui/src/root/useRootWorkspaceActions.ts`
- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/v4/composer/useDraftConfigControl.ts`

建议开启 `git rerere`，让重复的冲突解自动复用：

```bash
git config --global rerere.enabled true
```

同步完成后再更新锁、预算与改动清单：

```bash
cd /e/work/doyzheng/zcode-ide
node scripts/patch-budget.mjs   # 数字变了就同步修改 patchBudget.maxModified
node scripts/bootstrap.mjs --update
# 必须同步更新 CHANGES-VS-UPSTREAM.md：§0 数字、§3 逐文件、§8 追加一行同步记录
```

## 4. 同步官方更新的步骤

```bash
cd /e/work/doyzheng/zcode-ide/vendor/ZCode

# 1. 拉官方更新（走代理）
git fetch upstream --tags

# 2. 快进 main
git checkout main
git merge --ff-only upstream/main

# 3. 把补丁分支变基到新 main
git checkout ide-integration
git rebase main
# 冲突时逐个补丁解决；解决后 git rebase --continue

# 4. 重新构建验证（Node 24 + pnpm 10.33.2）
export PATH="/c/Users/<user>/scoop/persist/nvm/nodejs/v24.14.0:$PATH"
pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com
pnpm --filter "@zcode/tui..." build
pnpm --filter @zcode/server build
pnpm --filter @zcode/web build
pnpm --filter @zcode/web-ide build

# 5. 推到 Work（rebase 改写了历史，用 force-with-lease）
git push origin main ide-integration --tags
git push origin ide-integration --force-with-lease

# 6. 回到 zcode-ide：先记账，再打包
cd /e/work/doyzheng/zcode-ide
node scripts/patch-budget.mjs --json          # 核对修改/新增/排除文件数
# 更新 .agents/docs/upstream/CHANGES-VS-UPSTREAM.md（§0/§3/§8）并在 .agents/docs/changes/ 追加一条同步记录——必须
node scripts/bootstrap.mjs --update            # 更新 vendor/zcode.lock
node scripts/build-runtime.mjs
JAVA_HOME="$USERPROFILE/.jdks/jdk-21.0.12.1+1" ./gradlew buildPlugin
```

> **记账是同步流程的一部分，不是可选项**：漏更新 `CHANGES-VS-UPSTREAM.md` 会让下一次同步失去基线，也会让补丁预算失去解释。

> 第 3 步若 rebase 冲突过大，可改用 `git merge main`（保留合并提交），补丁历史会变成非线性，但省事。二选一后保持一致。

> rebase 后 `pnpm-lock.yaml` 若冲突：以官方版本为基，重新 `pnpm install` 让它自然生成（web-ide 的依赖会自动并回）。

## 5. 检查同步是否完整

```bash
# 补丁仍在顶端（当前 7 个 fix/feat 提交，以 git log 为准）
git log --oneline main..ide-integration

# 与 Work 一致
git fetch origin && git status

# 插件端到端仍工作：装包后发一条消息验证（见 deploy-zcode-plugin skill）
```

## 6. vendor/ZCode 工作副本

`E:\work\doyzheng\zcode-ide\vendor\ZCode` 是 fork 的完整工作副本（自带 `.git`，分支 `ide-integration`），被插件仓库的 `.gitignore` 整体忽略。fork 侧的提交/推送都在该目录里执行：

```bash
git -C vendor/ZCode status
git -C vendor/ZCode push origin ide-integration
```

失效或需要重新拉取时删除该目录再跑 `node scripts/bootstrap.mjs`（会按 `vendor/zcode.lock` clone 并切到锁定 commit）。删除前先确认没有未提交、未推送的提交。
