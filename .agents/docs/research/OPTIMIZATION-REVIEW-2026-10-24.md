# 官方源码改动优化空间审查报告

> 审查时间：2026-10-24。基线：fork `ide-integration` 分支 vs 上游 `3c5b2276`。
> 方法：4 个只读子代理并行逐文件 diff 审查 + 第 2 轮主审逐条对代码复核（下文以 `【复审修正】` 标记与第 1 版的差异）。
> 用途：回答「在尽量不改官方源码的原则下，当前实现还有多少收缩空间」。**本文档是分析结论，尚未实施任何改动。**
> 事实优先级：本文档描述的是审查时点的代码状态，若代码已演进，以当前代码为准。

> **决策变更（2026-10-24）**：不向上游提 PR。fork 由我们自行 `git fetch upstream` + rebase/merge 同步到 Work，补丁面由 `scripts/patch-budget.mjs` 控制。下文第 4 节与第 5 节的“上游化”表述仅保留为分析记录；落地方式见 [`ZCODE-UPSTREAM-SYNC.md`](../upstream/ZCODE-UPSTREAM-SYNC.md) 的「补丁预算」。

## 0. 总结论（TL;DR）

当前 34 个改动文件中，真正动官方源码的是 **25 个**（另有 `packages/web-ide` 8 个自建包、`pnpm-lock.yaml` 1 个被动追加）。

【复审修正】第 2 轮把原先的「立即可减 5 个」下调为 **可立即减 4 个**，并确认当前工作区存在 **2 个必须先修的 P0 缺陷**：

- **可立即减 4 个（低风险）**：2 个纯按钮隐藏的侧栏文件改为 CSS 下沉；自愈链移出 `useProjectTree` + `workspaceSessionsIndexSubscriptionSet` 2 个文件。
- **暂缓减 1 个**：`legacy-remote-tasks.ts` 的「脚本替代」方案不等价（见 3.1①），暂不删除。
- **权衡后最多再减 3 个**：放弃右上角 ➕ 半成品功能的三连透传链（`WorkspaceHeader` + `shared.ts` + `ActionSection`）。
- **9 个文件是通用改动**（无显式 IDE 门控），rebase 时重点核对；不计划提上游。
- 全部落地后官方源码改动可从 **25 个压到 18 个**（激进路线）。按 2026-10-24 决策不向上游提 PR，因此 9 个通用改动会保留在 fork 里，靠补丁预算控制每次同步的冲突成本。

一个此前未被记录的关键事实：`web-ide/src/styles.css` 目前只有 3 行有效内容（`@import` 官方样式 + Tailwind `@source` 扫描声明），**没有任何 IDE 隐藏规则**——所有 UI 精简 100% 靠官方包内的 `isIdeHost()` 条件渲染实现。而该 CSS 只被 IDE 入口 `main.tsx:16` 加载，是最大的未利用承接点。

【复审修正】两个必须先修的缺陷（不属于「收缩」，属于既有实现的质量问题）：

1. **自愈 effect 未按宿主门控**：`useProjectTree` 新增的自愈监听只判 `if (registry) return`，独立 web 端同样会跑，与「桌面端/独立 web 端零行为变化」的纪律冲突（见 3.5）。
2. **IDE 侧栏项目过滤无路径兜底**：严格相等匹配 `project.roots`，工作区为子目录 / junction / 盘符大小写不一致时整栏空白（见 3.3）。

## 1. 现状构成（34 个文件）

| 层 | 文件数 | 性质 |
|---|---|---|
| `packages/web-ide` | 8 | 自建入口包，不进上游代码路径，同步零冲突 |
| `packages/ui` | 19 | `isIdeHost()` 门控 + 通用逻辑修复（`WorkspaceShellLayout` 跨提交层，按 1 个计） |
| `packages/server` | 2 | local 宿主装配（`entry-http.ts`）+ 旧任务兼容（`legacy-remote-tasks.ts`） |
| `packages/shared` | 2 | Windows 盘符身份归一化（含测试） |
| `apps/zcode-cli/core` | 2 | 远程会话路径自愈（含测试） |
| `pnpm-lock.yaml` | 1 | web-ide importer 纯追加 40 行，被动保留 |

`packages/ui` 的 19 个里，**已提交 14 个、未提交 5 个**（`SettingsPage`、`WorkspaceShellLayout`、`useProjectTree`、`sessionsIndexStore`、`useWorkspaceSessionsIndexItems`、`workspaceSessionsIndexSubscriptionSet` 共 6 个文件有未提交改动，其中 `WorkspaceShellLayout` 已在已提交部分计过 1 个）。

## 2. 承接手段盘点（结论依据）

| 手段 | 能做什么 | 关键限制 | 同步上游稳定性 |
|---|---|---|---|
| web-ide `styles.css` | 隐藏/压缩任意 DOM | 改不了逻辑与数据过滤 | 中：优先用 `data-testid`（上游 e2e 实际引用，比重构类名稳）；失效为「元素复现」，可见可查 |
| Root props（`root/types.ts:54-102`） | 壳层形态开关（`isDesktop`、`allowRemoteWorkspace`、`supportsEmbeddedBrowser` 等） | 深层组件无透传链，仅 1 个插槽（`initialWorkspaceLoadingFallback`） | 高：签名漂移在构建期暴露 |
| services 覆写（`main.tsx:72-79` Proxy） | 隐藏/包装任意 service | 改不了 UI 渲染 | 中高：service 名变更可被 `?.` 吞掉而静默失效 |
| platform 覆写（`idePlatform.ts`，约 60 个方法入口） | 未实现即自动隐藏对应入口 | 仅限走 platform 分支的能力 | 中高：新增可选方法默认 undefined=隐藏，安全 |
| Kotlin `executeJavaScript` | 持久 style 注入（head 内不被 React 冲掉）、自带定时器的脚本 | `#root` 内 DOM 修改会被重渲染冲掉；`onLoadEnd` 后有 handler 空窗期 | 低：与内部结构耦合最深 |
| server 环境变量 / 启动前脚本 | 持续行为开关 / 一次性数据迁移 | 改不了 server 进程内装配逻辑（env 会被 agent 子进程继承） | 高：失效会显式报错而非静默 |
| ideContextPush / ideBridge 消息 | IDE↔页面事件交互 | 不适合承载形态常量 | 高：协议自建，上游无感知 |

重要边界事实：

- `#root` 内的 DOM 注入会被 React 重渲染冲掉；插入 `document.head` 的 `<style>` 持久有效。
- `isIdeHost()`（`packages/ui/src/lib/ideHost.ts:7-10`）每次调用实时解析 `window.location.search` 的 `ideHost=1`，全会话稳定（全 ui 包仅 `WebRemoteControlMobileShell.tsx:37` 一处 `pushState`，且不换 search）。
- web-ide 的 `styles.css` 只被 `web-ide/src/main.tsx:16` 加载，`@zcode/web-ide` 未被任何其他包依赖——CSS 规则**天然只作用于 IDE 形态，无需任何门控前缀**。
- 【复审修正】CSS 下沉能生效的前提是 Tailwind v4 的分层模型：utilities 在 `@layer` 内，未分层的手写规则优先级更高，`[data-testid=...]{display:none}` 能压过组件的 `flex` 类。若上游把自定义 CSS 收进 layer，需要重新验证。

【复审修正】四个侧栏 testid 的来源并不统一：只有 `automations-open` 来自 `packages/shared/src/test-ids.ts:722`；`sidebar-search-open`（`ProjectSidebarListHeader.tsx:58`）、`sidebar-view-menu`（`:72`）、`plugin-store-sidebar-open`（`ProjectSidebarNavigation.tsx:59`）都是组件内字面量。稳定性依据是「上游 e2e 实际引用这些字符串」（如 `packages/desktop/test/e2e/.../conversation-session-project-behavior.test.ts:550/559/761`），不是「由 shared 统一维护」。

## 3. 优化空间明细

### 3.1 立即可移除（约 -4 个文件，低风险）

**① 【复审修正】`packages/server/src/legacy-remote-tasks.ts` + `entry-http.ts` 内调用块（35-45 行）—— 判定「暂缓」，不是「立即可删」**

第 1 版把它判为防御性死代码并建议用插件仓库的幂等脚本替代。第 2 轮核实后，**结论方向仍成立，但替代方案不成立，风险从「低」上调为「中」**：

- 它确实只修 `host_id = remote:server:<id>` 且 `workspace_identity` 为空的历史行；local 形态（`261fa358`）后新写入的任务全是 `ownerHostId="local"`，不再产生脏行。本机跑完 `migrate-tasks-to-local.cjs` 后恒命中 0 行。
- 但现有迁移脚本 `scripts/migrate-tasks-to-local.cjs` **不是通用幂等修复**：
  - `:16` 硬编码 `path.join(os.homedir(), ".zcode", "v2", "tasks-index.sqlite")`，**不读 `ZCODE_DATA_BASE_DIR`**；而 server 侧走 `getTasksIndexDatabasePath()` → `getAppConfigDir()`（`packages/services/src/paths.ts:14,189`），测试隔离或自定义数据目录下两者指向不同的库。
  - `:31` 硬编码 `REMOTE_HOST = "remote:server:<host>"`，`:22-27` 硬编码三个项目 UUID——是本机一次性迁移，换机器无效。
  - 默认 `--dry-run`；`--apply` 每次都先建备份目录，不存在第 1 版说的「命中 0 行即退出、开销一条 SELECT」。
- 因此「`ServerProcess.kt` spawn 前执行现有脚本」会让插件多出第二套路径解析，并可能读错库。要做这个替代，必须**新写**一个通用修复脚本并用 `getAppConfigDir()` 口径解析路径。
- 收益只有 1 个文件，与工作量/风险不匹配，**建议暂缓**；若确定要删，先在 Kotlin 侧对齐路径规则并补 dry-run 输出验证。

**② `ProjectSidebarListHeader.tsx`、`ProjectSidebarNavigation.tsx` —— 整文件还原，4 条 CSS 规则替代**

- 【复审修正】`ProjectSidebarNavigation` 是纯按钮隐藏（自动化 / 插件市场），结论不变。
- 【复审修正】`ProjectSidebarListHeader` 的描述需要更准确：它**不是**用 `isIdeHost()`，而是新增 `hideActions` prop（`:22,29`），并改动了 `groupedActionsRef` 容器的显隐（`:45`）。但 IDE 模式下 `project-sidebar/index.tsx` 的 `ideHost` 分支直接按 timeline 渲染（`:283-290`），`view === "grouped"` 的 `TaskGroupedView` 永不渲染，该容器是空的——所以还原后仍安全，只是还原时需同步删掉父文件里的 `hideActions={ideHost}`（`:278`）。
- 替代实现（web-ide `styles.css`，无需门控前缀）：

```css
[data-testid="sidebar-search-open"],
[data-testid="sidebar-view-menu"],
[data-testid="automations-open"],
[data-testid="plugin-store-sidebar-open"] { display: none; }
```

- 按钮已核实无订阅、无 RPC 副作用；`display:none` 同时把它们移出无障碍树，行为等价。

**③ 【复审修正】sessions-index 自愈链收缩：未提交 ui 文件 6 → 4（不是 3）**

现链路：`useProjectTree` effect → `subscriptionSet.resyncFor` → `store.resyncNow()`。

第 1 版称「6 → 3」，实际未提交的 6 个 ui 文件里 `WorkspaceShellLayout` 也在（其改动是草稿头部门控，与自愈无关），收缩后剩 **4 个**（`SettingsPage`、`WorkspaceShellLayout`、`sessionsIndexStore`、`useWorkspaceSessionsIndexItems`）；只统计自愈链相关文件时才是 3 个。

收缩方案（第 2 轮建议分两步）：

- **第一步（只搬迁、不改语义）**：把监听 effect 迁入 `useWorkspaceSessionsIndexItems`——它确实同时持有 `baseServices: IServiceAccessor`（含 `zcodeTaskService`）和 `subscriptionSet.getStore(...)`（`:177` 已在用）。`resyncFor` 可内联为按 `scopesRef.current` 逐个 `getStore({workspaceKey, endpointKey})?.resyncNow()`，然后删除 `workspaceSessionsIndexSubscriptionSet.ts` 的 `resyncFor`（13 行，`129-149`）。`useProjectTree` 随之还原。
- **第二步（可选的行为改进）**：第 1 版称「按事件所属 scope 重订没有盲区，行为反而更准」。这在桌面端成立（侧栏展示多个 workspace 时，非活动 workspace 的订阅失效不会自愈），但**不是纯收益**：
  - 现方案只重订活动 workspace 是**刻意的节流**（注释写明「整批重订会放大成数十次 RPC」）；改成按 scope 重订会提高事件风暴下的 RPC 量，需要量化。
  - `useWorkspaceSessionsIndexItems` 是通用 v4 hook，把自愈塞进去后，任何未来消费者都会继承这套行为；且该 hook 目前没有宿主门控。
  - 建议：先做第一步（-2 个文件，风险低）；第二步单独立项，带 RPC 量对比数据，并决定是否用 `isIdeHost` 门控。

不可再低于 3 个的最小集合及理由：

| 文件 | 理由 |
|---|---|
| `SettingsPage.tsx:2110`（1 行 + import） | `projectMemoryViewerAvailable` 由调用方从 `isDesktop` 算出；传 `isDesktop={true}` 会连带启用桌面设置分区（`:682` 的 remoteDevices 重置、`:1613` 的 `isSettingsSectionAvailable`），违背「不伪装桌面」决策 |
| `sessionsIndexStore.ts`（`resyncNow()`，19 行） | transport 与 generation 均为 store 私有，是唯一安全重订层；上游已有的 `resync` RPC 要求订阅仍被本端持有，救不了「被服务端静默丢弃」场景 |
| `useWorkspaceSessionsIndexItems.ts` | 收缩后唯一同时够到事件源与 store 的层 |

### 3.2 CSS 下沉与功能取舍（需权衡）

**④ `WorkspaceHeaderActionSection.tsx` 隐藏半下沉（保留 ➕ 时）**

- help/terminal/side-pane 三个按钮的隐藏可用 3 条 testid 规则（`workspace-help-menu-trigger`、`terminal-toggle`、`side-pane-toggle`，常量见 `packages/shared/src/test-ids.ts:45,46,554`）下沉 CSS；
- diff 从 75 行（56+19）缩到约 30 行（只剩 ➕ 按钮分支，`ide-header-new-task`）；
- 参照系：`ConversationShareMenu` 的隐藏门控写在父组件里（`WorkspaceHeaderActionSection.tsx:64-73` 的 `isDesktop !== false`），不是组件自身——所以「上游 props 够用时无需任何改动」这句话对 share 菜单成立，但依据要改成父组件门控。

**⑤ ➕ 三连（`WorkspaceHeader.tsx` + `WorkspaceHeaderSections/shared.ts` + `WorkspaceHeaderActionSection.tsx`）—— 建议评估砍掉**

- 三个文件是一条纯透传链，只为头部「新建对话 ➕」服务；
- 上游 `shouldRenderWorkspaceHeader` 要求 `activeTaskId !== null || isDesktop`（`WorkspaceShellLayout.tsx:1918`），IDE 下无活动任务时 header 整个不渲染——➕ 本就是半成品（即 [`STATUS.md`](../development/STATUS.md) 待办中「欢迎页没有右上角 ➕」），而侧栏 `NewTaskButtonGroup` 已有新建入口；
- 【复审修正】③' 与 ④ 有**硬依赖**：`WorkspaceHeaderActionSection.tsx:95-118` 在 `ideHost` 分支里整体替换了 help/terminal/side-pane。若不加 ④ 的三条 CSS 就整链还原，这三个桌面按钮会重新出现在 IDE 头部——是可见功能回归，不是「可选优化」。
- 【复审修正】砍 ➕ 后，`WorkspaceShellLayout` 里两行 `onToggleSidebar={handleToggleSidebar}`（`:2080`、`:2507` 附近）也应一并消失，`WorkspaceHeader` 的 `onToggleSidebar`/`onCreateTask` 透传同步删除。这部分 diff 收缩第 1 版没算进去。

**⑥ `WorkspaceShellLayout.tsx` 未提交部分（草稿头部项目/分支切换隐藏）—— 建议保留源码**

- CSS 技术上可行但有硬伤：header wrapper（`ConversationComposer.tsx:2621`）**没有 testid**，只能靠 Tailwind 类组合选择器；
- 且 `contextHeader` 的存在还控制输入框卡片样式（第 2607 行 `rounded-2xl bg-surface shadow-xl/5`），完全复刻 `undefined` 效果需要第二条 `:has()` 规则还原圆角/背景/阴影；
- 2 行源码门控（`1557-1558`）比这稳定得多。

**CSS 方案的共性代价与护栏**：失效是静默的（按钮复现），源码门控失效是同步时的显式冲突——前者运行期可发现、后者构建期可发现。缓解：给 web-ide 加一个冒烟断言（构建后用 CDP 检查被隐藏 testid 的 computed `display` 为 none），把静默失效变成显式报警。加上护栏后 CSS 下沉风险可控。

### 3.3 不可移除内核（各审查一致确认）

| 文件 | 改动 | 外部手段不可达的原因 |
|---|---|---|
| `App.tsx`（+60/-6） | 文件点击转 IDE 编辑器（拦截 + 路径归一化） | 病灶在 React 事件链顶层，CSS/DOM 注入均不可达 |
| `project-sidebar/index.tsx`（+50/-4） | 仅当前项目的任务列表过滤 + `projectId` 条件展开修复 | 渲染分支按项目过滤数据，CSS 只能藏整块；tree 是全量推送，services 覆写也不行 |
| `composerRecent.ts`（+49/-12） | Recent 双写 + 读回退 | localStorage 键编解码完全在 ui 包内，services Proxy 拦不到 `browserStorage()` |
| `useRootWorkspaceActions.ts`（+27/-4） | identity 沿用 + `alreadyAttached` | Root 内部导航流；不修则 IDE 点新建直接抛 `project.remote-navigation-unavailable` |
| `useDraftConfigControl.ts`（+12/-1） | 播种闸门 | React 渲染期状态机内部，无外部钩子 |
| `SessionPane.tsx`（+3/-1） | `externalTextInsertRequest` 放宽（`:5433-5435`） | store→composer 渲染管线内部；1 行 diff 无同步风险 |
| `DesktopTopOverlay.tsx` | 隐藏任务前进/后退（`:168-175`，`hideTaskNavigationButtons \|\| ideHost`） | 有效 diff 仅 1 行；forward 按钮无 testId，CSS 需兄弟选择器 hack，比源码更脆——**不值得砍** |
| `WorkspaceShellLayout.tsx` 已提交部分 | 侧栏折叠把手（`:2313-2331`）+ 透传 | 侧栏可见性是 `hooks/useAppPanels.ts` 内部 React state（`handleToggleSidebar` 直接 `setIsSidebarVisible`），web-ide/Kotlin 侧无任何通道可切换 |
| `lib/ideHost.ts`（新增 10 行） | 形态探测 | 被 7 个文件依赖；新增文件零冲突 |

【复审修正】`project-sidebar/index.tsx` 的过滤有一个**未被审查的健壮性缺口**：`normalizeProjectPath`（`:69-70`）只做小写 + 斜杠统一 + 去尾斜杠，然后与 `project.roots` **严格相等**比较（`:172-190`）。以下情况会得到 `ideProject = null` → `ideTasks = []` → **整栏空白**：

- 工作区是项目根的子目录（多根项目 / 子目录打开）；
- 路径经过 junction/symlink（如 `vendor/ZCode`）导致字面值不同；
- 服务端规范化的盘符大小写与本地 `props.workspacePath` 不一致。

建议：加 `path === root || path.startsWith(root + "/")` 前缀兜底；完全匹配失败时回退展示全量未归档任务并给一条通知，而不是静默空列表。

**集中化方案审查结论**：Context Provider / Root 自定义 prop 两种「注入式集中化」均为负收益——

- Context 需要 7 个消费点把 `isIdeHost()` 改成 `useIdeHost()`，diff 面不变还多出 Provider 接线，且 hook 无法在 lib 层文件使用；
- Root prop 则把冲突转移到 `Root.tsx` 这个更大的高冲突文件。

**真正的集中化就是 3.1/3.2 的下沉**：隐藏类消费点消失后，`isIdeHost()` 调用点自然从 7 个降到 4~5 个纯逻辑点。

### 3.4 数据层专项（server / shared / cli）

| 文件 | 性质 | 结论 |
|---|---|---|
| `server/entry-http.ts` | local 装配（`createLocalServices` 替代 `createServerHostServices`） | **必须保留**：`ownerHostId` 在每次任务/项目写入时由装配注入（`node.ts:2178` 的 `projectStorageHostId`、`node.ts:2687` 的 `?? "local"`），一次性脚本只修存量修不了增量；上游无 env 开关可替代（`ZCODE_SERVICE_AUTHORITY_MODE` 只被 `entry-stdio.ts` 消费，HTTP 入口不读）。移除 3.1① 的调用块后 diff 缩至约 15 行 |
| `shared/remote-workspace-identity.ts` + 测试 | 盘符 parse 还原（`restoreWindowsDrivePathFromIdentity`）+ hostId 裁剪修正 | **必须保留**：identity 是存量主键（tasks 表 `workspace_key`、session `workspaceID`、alias 匹配全用它），改格式 = 全量数据迁移；parse 侧还原是唯一不迁数据的修法；fork 保证 `build(parse(identity)) === identity` 恒等、hostId 裁剪对 POSIX 逐字节等价 |
| `cli/persisted-remote-session-path-repair.ts` + 测试 | 5 行白名单扩展（`:29-33`：`value === `/${workspacePath}``） | **必须保留**：运行在 `zcode.cjs app-server --stdio` 子进程内，插件只能控制环境变量无法注入代码；改动符合该文件「已知且可证明的污染形态才修」的既有设计；严格依赖盘符 parse 修复，两者是同一条 bug 链 |
| `server/legacy-remote-tasks.ts` | 历史脏数据修复 | **暂缓移除**（见 3.1①）；真要做替代，需先写通用脚本并统一路径解析口径 |
| `pnpm-lock.yaml` | web-ide importer 追加 | **保留**：移出 workspace 需 `workspace:*` 改 `link:`，引发 `pnpm --filter` 失效、React 双实例风险，得不偿失。冲突处理保留双方 importer 或 `pnpm install --lockfile-only` 重生成 |

### 3.5 【复审新增】未提交改动的风险复核（P0）

这两项不是「收缩」问题，是当前工作区里已经存在的质量缺口，建议在推进任何收缩之前先修。

**P0-1 自愈 effect 没有宿主门控**

- 位置：`useProjectTree.ts` 新增 effect（`331-352` 附近）。
- 现状：只判 `if (registry) return;`。`registry` 为空的条件是 `services.windowControllerService` 不存在——桌面端有（返回），**IDE 和独立 web 端都没有**（都会执行）。
- 影响：独立 web 端会多出 `onDynamicWorkspaceEvent` 订阅和周期性重订；这与 [`INVARIANTS.md`](../development/INVARIANTS.md) 第 4 条「UI 改动一律走 `ideHost=1` 门控」以及第 1 版 §7 的「桌面端与独立 web 端零行为变化」表述冲突。
- 修法：加 `if (!isIdeHost()) return;`（若独立 web 确实需要自愈，则在注释和文档里写明理由，并补独立 web 的验证记录）。

**P0-2 消息推送的静默丢弃**

- 位置：`ZCodePanel.kt:159-184`、`ZCodeIdeService.kt:29-30`。
- 现状：`drainPendingPushes` 先清空队列，再在 `invokeLater` 里执行 `window.__zcodeIdeMessage && window.__zcodeIdeMessage(...)`。handler 未注册时 `&&` 短路，**消息已出队且无任何日志**。叠加 service 层的单槽 `queuedWebviewMessage`（新消息覆盖旧消息），丢失面比「onLoadEnd 窗口期」更宽。
- 修法（不在 Kotlin 侧加复杂度）：在 `injectBridge` 阶段、React 挂载之前先装一个缓冲区——

```js
window.__ZCODE_IDE_PENDING__ = [];
window.__zcodeIdeMessage = (m) => window.__ZCODE_IDE_PENDING__.push(m);
```

`web-ide/src/ideBridge.ts` 注册真实 handler 时先 flush 该数组并把 `window.__zcodeIdeMessage` 换成真实实现。这样窗口期内的消息全部保留，单槽覆盖问题也随之消失。

## 4. （未采用）上游化路线——保留为分析记录

共识别 **9 个无 `isIdeHost` 门控的通用修复**文件，对上游用户同样正确，按上游化阻力排序：

1. **Windows 盘符链（4 文件，阻力最低，应最先做）**：任何把 source server 跑在 Windows 上的用户都会中 `E:\E:\x`。PR 卖点：`build(parse)` 恒等保证存量身份键零漂移、hostId 裁剪对 POSIX 逐字节等价、附往返测试。`persisted-remote-session-path-repair` 的 5 行白名单符合该文件既有设计模式，随同一 PR。
2. **`composerRecent.ts`**：任务列表「新建任务」不带 projectId 导致最近模型回落默认值，上游真实 bug。
3. **`useRootWorkspaceActions.ts`**：identity 沿用对直连桌面场景同样正确。
4. **`useDraftConfigControl.ts`**：播种闸门（PR 需说明播种条件放宽的回归考量）。
5. **`SessionPane.tsx`**：1 行放宽，桌面既有写入方（推荐提示词）只会在草稿态触发，不破坏上游。
6. **`entry-http.ts`**：以 env 开关形式上游化（如 `ZCODE_SERVER_STORAGE_MODE=local|remote`，默认 remote 保持现行为）——上游已有 `ZCODE_SERVICE_AUTHORITY_MODE` 的 env 开关先例（`shared/src/serviceAuthority.ts` + `entry-stdio.ts` 消费），符合其设计语言。

【复审修正】第 6 项有两个第 1 版没提的差异，PR 里必须处理：

- `createServerHostServices` 还返回 `workspaceIdentityMapper` 与 `migrationFailedPathCount`，并给 `createHttpServer` 传 `virtualProjects: true`；`createLocalServices` 这条路径没有。env 开关不能只切服务工厂，还要保持 remote 模式的这三个行为不变。
- 若 `ownerHostId` 只由装配注入，env 开关必须保证 local 模式下 `projectStorageHostId` 仍缺省为 `"local"`（`node.ts:2687`），否则任务会写回 remote 身份。

【复审修正】建议补第 10 个候选：**`SettingsPage.tsx:2110`**。现在的 `Boolean(isDesktop) || isIdeHost()` 语义其实是「本机能否读记忆目录」。推成 platform 能力位（对齐 `canOpenLocalFiles` 这类既有设计），既符合上游语言，又能让这个 1 行文件退出残留名单。

## 5. 执行路线图（【复审修正】重排）

| 步骤 | 动作 | 官方源码文件数 | 风险 |
|---|---|---|---|
| 现状 | — | 25 | — |
| **P0** | 修自愈 effect 门控 + 侧栏路径兜底 + 消息缓冲 | 25（不减文件） | 低（修缺陷） |
| ① | 4 条 testid CSS 还原 2 个侧栏文件 | 23 | 低 |
| ② | 自愈链收缩第一步（只搬迁、不改语义） | 21 | 低 |
| ③ 保守 | ActionSection 隐藏半下沉 CSS，保留 ➕ | 21（该文件 diff -60%） | 低 |
| ③' 激进 | 砍 ➕ 三连（**前提：④ 的三条 CSS 已落地**） | 18 | 中（产品取舍） |
| ④ 暂缓 | 删除 `legacy-remote-tasks.ts`（需先写通用脚本） | 17 | 中 |
| 长期 | （不采用）9 个通用修复上游化合入 | 保守 → 12 / 激进 → 9（含 legacy）/ 8（后续删 legacy） | 改为自行同步，补丁面受预算约束 |

激进路线 + 上游化全部落地后的最小残留集合（9 个）：`ideHost.ts`（零冲突新增）、`App.tsx`、`DesktopTopOverlay.tsx`（1 行）、`WorkspaceShellLayout.tsx`、`project-sidebar/index.tsx`、`SettingsPage.tsx`（1 行）、`sessionsIndexStore.ts`、`useWorkspaceSessionsIndexItems.ts`、`legacy-remote-tasks.ts`（暂缓项）。

第 1 版写「残留 8 个」，是把 `legacy-remote-tasks.ts` 按「已删除」计入的；在 3.1① 降级为「暂缓」后，近期可达成的是 9 个。

### 5.1 【复审新增】冲突成本评级（比文件数更有指导性）

fork 的上游历史是**压缩同步**的（`upstream/main` 共 6 个 commit，HEAD 即基线 `3c5b2276`），**无法测量真实的 upstream churn**。因此不能用「上游改得频不频繁」排序，改用三个可观测维度：

| 维度 | 低冲突成本 | 高冲突成本 |
|---|---|---|
| 新增 vs 修改 | 纯新增文件（`ideHost.ts`） | 改写既有大文件内部逻辑 |
| diff 形态 | 1 行条件 / 常量替换 | 整块 JSX 重排、缩进连锁 |
| 方向一致性 | 与上游重构趋势同向（能力位、platform 化） | 逆向上游抽象（往组件里塞宿主分支） |

按此口径，`DesktopTopOverlay` / `SettingsPage` / `SessionPane`（各 1~3 行）的实际风险低于 60 行的 `App.tsx`，即使它们都算 1 个文件。排期时建议按「评级 × 改动频率预期」而不是单纯数文件。

### 5.2 配套小改进

- `WorkspaceShellLayout.tsx` 的 19 行把手 JSX（`:2313-2331`）抽成独立组件，该 2800 行高冲突文件的 diff 可压到约 3 行（导入 + 1 处调用）；砍 ➕ 后另外两行 `onToggleSidebar` 透传也一并消失。
- 【复审修正】路径归一化**不要**按第 1 版那样三合一。实际是两种语义：
  - `App.tsx:108-124` 的 `normalizeIdeFilePath`：消解 `.`/`..`、保留大小写与分隔符风格，用于构造可打开的文件路径；
  - `useRootWorkspaceActions.ts:63-67`、`web-ide/src/main.tsx:60-62`、`project-sidebar/index.tsx:69-70`：转小写 + 统一斜杠 + 去尾斜杠，仅用于等价比较。

  合并前者会引入大小写敏感 bug。真正重复的是后三份，可抽到零冲突新文件；其中两份所在文件本来就要改，收益只在「少一处重复」。
- `ideHost.ts` 加模块级缓存（当前每次渲染 `new URLSearchParams`）。
- web-ide 冒烟断言护栏（构建后用 CDP 检查被隐藏 testid 的 computed `display` 为 none）。

## 6. 缺陷与修法清单（【复审修正】§6.1 保持，§6.2 修法修正）

1. **消息丢失缺口**：`ZCodePanel.pushToWebview`（`ZCodePanel.kt:159-184`）在 `onLoadEnd` 之后、前端 `__zcodeIdeMessage` handler 安装之前的窗口期内，消息会被静默丢弃（队列已清空、不回队）；service 层 `queuedWebviewMessage` 还是单槽，新消息覆盖旧消息（`ZCodeIdeService.kt:29-30`）。修法见 3.5 P0-2。
2. **[复审修正] MCP 读取失败的静默吞错，但修法要改**：`idePlatform.ts:79-82` 的 fallback 返回 `{servers:[]}`，与 `saveMcpToUserDirectory`（`:83-96`）的 `{success:false, error}` 风格不一致。但 `LoadCliMcpFromUserDirectoryResult` 的定义（`packages/shared/src/mcp.ts:93-95`）**只有 `servers` 字段**，直接返回 `{success:false}` 会编译失败。正确做法：先给该类型加可选 `error?: string`，再让 fallback 返回 `{servers: [], error: "..."}`，或直接 `throw` 由上层统一处理。
3. `migrate-tasks-to-local.cjs` 的注释已写明「前置条件：插件 server 已改为 local 形态」；但它不是通用脚本（见 3.1①），不要再把它当作「启动前置步骤」的现成部件。
4. **[复审新增] 自愈 effect 未门控**、**IDE 侧栏路径匹配无兜底**：见 3.5 P0-1 / 3.3。

## 7. 结论

当前实现整体质量是好的——每个改动点都已是各自位置的最小实现，但「精简全靠源码门控」这一单一策略留下了一块明显的空白：**web-ide 专属 CSS 与启动前脚本两个零冲突承接点没用上**。

【复审修正】第 1 版说「门控纪律严格（桌面端与独立 web 端零行为变化）」，这**对已提交部分成立，对当前工作区不成立**：未提交的自愈 effect 没有宿主门控，独立 web 端会继承这套订阅/重订逻辑。在修掉它之前，不应把「零行为变化」当作既定事实写进结论。

落地建议：

1. 先修 3.5 的两个 P0 缺陷（门控 + 路径兜底）和消息缓冲；
2. 再按 ①②（CSS 还原侧栏 + 自愈链第一步搬迁）推进，这两步都是低风险、可独立验证；
3. `legacy-remote-tasks.ts` 暂缓，#️⃣ 不要用现有迁移脚本硬顶；
4. ➕ 做一次产品取舍；砍之前先落地 ④ 的三条 CSS；
5. 不向上游提 PR；fork 由我们自行 fetch + rebase 合并回 Work，冲突成本靠补丁预算控制（见 `ZCODE-UPSTREAM-SYNC.md` 的「补丁预算」）。

## 8. 相关文档

| 文档 | 关系 |
|---|---|
| [`CHANGES-VS-UPSTREAM.md`](../upstream/CHANGES-VS-UPSTREAM.md) | 改动清单（本文档的审查对象），实施收缩后应同步更新其文件数与分类 |
| [`IDE-HOST-ADAPTATION.md`](../architecture/IDE-HOST-ADAPTATION.md) | 宿主适配原则（`isDesktop` 的本质、「不伪装桌面」决策的出处） |
| [`ZCODE-UPSTREAM-SYNC.md`](../upstream/ZCODE-UPSTREAM-SYNC.md) | 上游同步流程；补丁预算与 rebase 关注点（第 4 节上游化路线未采用） |
| [`../../AGENTS.md`](../../../AGENTS.md) | 项目入口（索引）；实施后其指向的 [`WORK-MAP.md`](../development/WORK-MAP.md)「取舍准则」应补充「纯视觉隐藏优先 CSS 下沉」原则，以及 [`INVARIANTS.md`](../development/INVARIANTS.md) 中「自愈/重订类逻辑必须门控」的不变量 |

## 9. 修订记录

| 轮次 | 日期 | 变更 |
|---|---|---|
| 第 1 版 | 2026-10-24 | 4 子代理并行逐文件 diff 审查，产出 25→17→8 的收缩路线 |
| **第 2 版（对抗复审）** | 2026-10-24 | 修正 5 处事实/论证错误：`useProjectTree` 行数与 churn 依据、6→3 计数、三份路径归一化的语义识别、MCP 返回类型、3.1① 的脚本替代不等价；补充 3 处漏判风险：自愈未门控（P0）、侧栏路径匹配无兜底（P0）、消息静默丢弃的修法；修正 ③' 对 ④ 的硬依赖；重排路线图（25→18→9），新增 5.1 冲突成本评级 |

## 10. 实施记录（2026-10-24，第 2 版路线图的子集）

已完成：

- **① 侧栏 CSS 下沉**：`ProjectSidebarListHeader.tsx`、`ProjectSidebarNavigation.tsx` 还原至 `3c5b2276`；`project-sidebar/index.tsx` 移除 `hideActions={ideHost}`；`web-ide/src/styles.css` 新增 4 条 testid 隐藏规则。相对上游的 diff 减少了这 2 个文件。
- **② 自愈链收缩（第一步）**：监听 effect 从 `useProjectTree.ts` 迁入 `useWorkspaceSessionsIndexItems.ts`，并加 `isIdeHost()` 门控；按事件所属 scope 重订，频率由 `SessionsIndexStore.resyncNow()` 的 3 秒限流兜底；删除 `workspaceSessionsIndexSubscriptionSet.resyncFor`。`useProjectTree.ts` 与 `workspaceSessionsIndexSubscriptionSet.ts` 相对上游归零。
- **P0 兜底**：`project-sidebar/index.tsx` 的 IDE 项目匹配改为「完全相等或子路径前缀」；匹配失败时退回全量未归档任务，项目列表尚未加载时保持空列表（避免闪出其它项目）。

未实施（按 §5 顺位保留）：

- `legacy-remote-tasks.ts` 暂缓（替代脚本不等价，见 3.1①）。
- ➕ 三连未砍（产品取舍未做）；`WorkspaceHeaderActionSection` 半下沉未做。
- 消息缓冲未做（`ideContextPush.ts` 当时正被并行重构占用，见 3.5 P0-2）。
- 上游 PR 未发起（2026-10-24 决策：不推上游，改为自行 fetch + rebase 同步合并）。

验收结果：

| 检查 | 结果 |
|---|---|
| `tsc -b packages/ui` | 通过（exit 0） |
| `vitest run packages/ui/src/project-sidebar/activity` | 3 文件 / 13 用例通过 |
| `pnpm --filter @zcode/web-ide build` | 通过；产物 `index-C-eAbFGO.js`、`index-CMr2IGbX.css` |
| `node scripts/build-runtime.mjs` | 通过，dist 194M |
| `./gradlew buildPlugin` | 通过，zip 49M，内含上述两个产物 |
| 构建产物 CSS 内容 | 四个 testid 选择器 + `display:none` 已确认存在于 `index-CMr2IGbX.css` |
| `packages/ui/src/v4` 单测 | 无匹配 vitest include 的测试文件（"No test files found"，非失败） |
| oxlint（改动文件） | 仅 1 条上游既有警告：`project-sidebar/index.tsx` 的 `msg` 未使用 |

> 注：本表记录的是当时数值。后续 `build-runtime.mjs` 的体积统计从 `du`（磁盘占用）改为逻辑字节，同样内容显示为 184M / zip 48M。

未覆盖的验收：

- 未部署到运行中的 IDE，因此「运行中任务转圈自愈」「四个按钮实际消失」尚未做 CDP 实机确认。
- 新增的自愈 effect 没有单测覆盖：现有 `packages/ui/src/project-sidebar/activity/**/contract.test.ts` 把 `useWorkspaceSessionsIndexItems` 整体 mock 掉了。

改动面提示：本次相对上游移除了 4 个文件（`ProjectSidebarListHeader`、`ProjectSidebarNavigation`、`useProjectTree`、`workspaceSessionsIndexSubscriptionSet`），但同一时间并行重构新增了 `platform.ts`、`useAppPanels.ts`、`codeViewer.ts`、`message.tsx` 等文件，所以仓库总文件数仍显示 34，不能直接与第 2 版的 34 对比。
