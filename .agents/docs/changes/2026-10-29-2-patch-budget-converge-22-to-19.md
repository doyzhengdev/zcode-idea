# 2026-10-29 · 补丁面收敛：22 → 19（App.tsx 还原 + 测试用例迁移）

- **范围**：`vendor/ZCode` 官方源码（还原 3 个文件的补丁）+ 2 个新增测试文件
- **触发**：用户要求审查其余补丁能否收敛；原则「不影响现在的功能就可以，由 AI 决策」
- **提交**：working tree（未提交）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/ui/src/App.tsx` | **还原为上游原状** | 补丁仅把 `(...args)` 透传收紧为 `(source: CodeViewerSource)` 类型签名 + 注释；`handleOpenCodeViewer` 内部已有 IDE 分支，行为完全等价，`git diff 3c5b2276` = 0 行 |
| `packages/shared/test/remoteWorkspaceIdentity.test.ts` | **还原为上游原状** | 我们加的 2 个盘符形态用例迁出到独立文件 |
| `apps/zcode-cli/.../persisted-remote-session-path-repair.test.ts` | **还原为上游原状** | 同上（1 个用例 + 自包含 helper 复制） |
| `packages/shared/test/remoteWorkspaceIdentity.ide.test.ts` | 新增（不计预算） | 迁移后的 2 个盘符用例 |
| `apps/zcode-cli/.../persisted-remote-session-path-repair.ide.test.ts` | 新增（不计预算） | 迁移后的 1 个用例 + helper 副本（注明与官方 helper 人工同步） |

**官方源码修改数 22 → 19，预算 19 / 23（余 4）；新增文件 15 → 17（2 个迁移测试不计预算）。**

## 为什么改

收敛分析（本轮全量审查 22 个补丁）的结论分三档：

1. **本档（立即可收敛，零行为差异）**：App.tsx 是纯文档性补丁；两个测试文件是我们加的用例，官方 vitest include（`packages/*/test/**/*.test.ts`）与 core 的 `vitest tests` 对同目录新文件天然生效，迁移后 runner 照常发现。
2. **评估后不做**：WorkspaceHeader 三件套的头部精简需要牺牲右上角 ➕ 按钮或引入 DOM 注入（违背「不影响现在的功能」）；`entry-http.ts` 收敛需复刻 200+ 行装配脚本，维护成本大于收益。
3. **保留 16 个**：点文件拦截束（`useAppPanels`/`platform.ts`/`codeViewer.ts`/`message.tsx`/`WorkspaceShellLayout`——拦截点在官方组件树内部，无外部事件可截获）、`isDesktop` 能力位类（`SettingsPage`/`WorkspaceSidebarFooter`——官方无能力位，CSS 无法显示不存在的 DOM）、行为修复类（`composerRecent`/`useDraftConfigControl`/`project-sidebar`/`useRootWorkspaceActions`/`sessionsIndexStore`/`useWorkspaceSessionsIndexItems`——alias 包装的重实现风险高于保留补丁）、协议缺陷（`remote-workspace-identity`——**通用 bug，建议反馈上游，上游修复即自动收敛**）、数据修复（`persisted-remote-session-path-repair.ts` 5 行 + `entry-http.ts`）。

## 行为变化

无。App.tsx 行为逐行等价；测试迁移后全部用例继续被 runner 执行（定向跑新旧两组全绿）。

## 验证

1. `git diff 3c5b2276 -- App.tsx` 与两个官方测试文件 = 0 行（上游原状）。
2. 定向测试：shared `remoteWorkspaceIdentity`（官方 8 + ide 2 = 10 passed）、core `persisted-remote-session-path-repair`（官方 8 + ide 1 = 9 passed）。
3. `patch-budget --worktree`：**修改 19 / 预算 23（余 4）**，新增 17。
4. 部署重启后实机回归（CDP，bundle `index-Cy4q95Nk.js`）：文件推送末尾追加 ✓、选区推送 code-comment 附件且正文不动 ✓、测试残留已清理 ✓。

## 风险 / 后续

- 迁移的 `persisted-remote-session-path-repair.ide.test.ts` 内 helper 是官方文件 helper 的副本，官方改 helper 时需人工同步（文件头已注明）。
- 后续候选（本轮评估后暂缓，需用户单独决策）：WorkspaceHeader 三件套的 CSS 承接（牺牲 ➕ 入口）、`remote-workspace-identity` 盘符缺陷反馈上游。
- `check-change-log` 对纯 vendor 改动不可见（fork 独立仓库），以本记录为准。
- 补丁清单已同步：`CHANGES-VS-UPSTREAM.md` 的 §0 数字（19/17/10/46）、§3.1–3.6 逐文件（含 2 个新增 `*.ide.test.ts` 条目）、§4 冲突分级（移除已还原的 App.tsx 与测试文件、更正新增文件数）、§6 验证清单、§8 记录。
