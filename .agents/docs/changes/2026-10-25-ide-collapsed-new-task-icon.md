# 2026-10-25 · IDE 形态顶部浮层与侧栏入口统一改由 CSS 承接

- **范围**：`vendor/ZCode/packages/web-ide`（IDE 入口样式）、文档；同时**撤回**此前的 `packages/ui` 官方源码补丁
- **触发**：用户反馈侧栏收起后左上角残留新建会话图标、侧栏顶部「新建任务」隐藏后容器仍占位、会话标题左侧出现空白；并明确要求「能用 CSS 解决必须用 CSS，减少修改源码」
- **提交**：working tree（本仓库与 fork 均未提交）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `vendor/ZCode/packages/web-ide/src/styles.css` | 修改 | 新增 4 组 IDE 专属规则：隐藏顶部浮层根节点、隐藏侧栏顶部导航容器、隐藏「新建任务」行、把 `pl-38`/`pl-44` 左侧留白清零 |
| `vendor/ZCode/packages/ui/src/DesktopTopOverlay.tsx` | **还原为上游** | 撤回此前 `isIdeHost()` 门控（任务前进/后退、侧栏开关），由 CSS 隐藏整个浮层替代 |
| `vendor/ZCode/packages/ui/src/WorkspaceHeader.tsx` | **还原为上游** | 曾尝试用 `isIdeHost()` 关闭顶栏左侧留白，最终改为 CSS，源码不改 |

官方源码**修改**文件因此从 23 个降到 **22 个**，补丁预算（上限 23）重新留出 1 个余量。

## 为什么改

三处空白的来源各不相同，但都属于「IDE 里该整块消失的桌面入口」：

1. **侧栏收起后的左上角图标**：`WorkspaceShellLayout` 把 `showNewTaskButton` 设为 `!isSidebarVisible`，顶部浮层为桌面端提供收起态的新建入口。IDE 里新建入口固定在头部右上角 ➕，这个浮层按钮脱离侧栏上下文。
2. **侧栏顶部空白占位**：`task-new-button` 与自动化/插件市场入口隐藏后，`sidebar-primary-navigation` 只剩 `py-3` 的上下内边距。
3. **会话标题左侧空白**：`resolveTopOverlayLeadingPaddingClass` 在侧栏收起时给 header 内层与 Side Pane tab 栏加 `pl-38`（152px），用来避让浮层按钮；浮层已空，留白就是纯空白。

最终全部放在 `packages/web-ide/src/styles.css`（只被 IDE 入口加载，桌面端与独立 Web 端天然零影响）：

- 顶部浮层根节点没有 `data-testid`，用 Tailwind 生成的容器名 `[class*="topoverlayer"]` 整块隐藏——IDE 里浮层本来就没有可用入口（前进/后退、侧栏开关、新建、更新都不适用）。
- 侧栏顶部导航有 `data-testid="sidebar-primary-navigation"`，整块隐藏，连同「新建任务」行。
- `pl-38`/`pl-44` 只由 `resolveTopOverlayLeadingPaddingClass` 产出，直接清零 `padding-left`，同时覆盖 header 与 Side Pane tab 栏两处调用点。

这样 `DesktopTopOverlay.tsx` 与 `WorkspaceHeader.tsx` 都无需保留补丁。

## 行为变化

- IDE 宿主：侧栏收起后左上角不再有孤立图标；侧栏顶部直接进入任务列表，无空白占位；会话标题左侧不再有 152px 留白；右上角 ➕ 仍可新建对话。
- 桌面客户端与独立 Web：完全不变（这些规则只存在于 IDE 入口样式表）。

## 验证

- `pnpm --filter @zcode/web-ide build`：通过（`index-BGNzPGJX.js` + `index-DEiPtweW.css`）；产物 CSS 中确认存在 `[class*=topoverlayer]{display:none}` 与 `.pl-38,.pl-44{padding-left:0}`。
- **实机验证（IDE 内 JCEF + CDP）**：在真实会话页收起侧栏后读取计算样式：
  - header 内层仍带 `pl-38` 类，但 `padding-left` = `0px`；
  - 顶部浮层根节点 `display: none`；
  - `sidebar-primary-navigation` 为 `display: none`，`task-new-button` 不占尺寸；
  - 头部右上角 `ide-header-new-task` 仍可见。
- `node scripts/patch-budget.mjs --worktree`：22 修改 / 3 新增 / 预算 23，未超。
- 重跑 `node scripts/build-runtime.mjs` + `./gradlew buildPlugin`（JDK 21）；插件目录的 `runtime/web` 已同步为同一份产物。
- **未做**：桌面端 / 独立 Web 未单独回归（改动仅存在于 IDE 入口样式表）。

## 风险 / 后续

- `[class*="topoverlayer"]`、`pl-38`/`pl-44` 都是 Tailwind 生成的名字，上游改名时会静默失效，表现为对应元素重新出现——可见可查，但需要同步修正选择器。
- 若后续 IDE 需要浮层入口（例如自定义更新提示），必须先把该入口从整块隐藏中排除。
- 本次改动全部是视觉裁剪，没有触碰 Dialog、快捷键等行为逻辑。

## 相关

- `.agents/docs/development/IDE-UI-TRIMMING.md`（本次经验沉淀成的操作手册）
- `.agents/docs/development/INVARIANTS.md` 第 22 条
- `.agents/docs/architecture/IDE-VS-DESKTOP.md` §0 / §1.2 / §2 / §10
- `.agents/docs/architecture/HANDOFF.md` §4.14
- `.agents/docs/upstream/CHANGES-VS-UPSTREAM.md` §0 / §2 / §3.4
