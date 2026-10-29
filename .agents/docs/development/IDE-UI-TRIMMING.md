# IDE 形态 UI 裁剪（CSS 优先）操作手册

> 适用场景：某个桌面端入口、浮层或留白在 IDE 工具窗口里不该出现。
> 结论先行：**先找 CSS 选择器；CSS 不能稳定命中时，才加 `isIdeHost()` 门控；只有初始化/状态/数据逻辑才动官方源码。**
> 本文来自 2026-10-25「侧栏收起后残留新建图标 / 顶部空白占位 / 会话标题左侧留白」的三次返工，规则已同步进 [`INVARIANTS.md`](./INVARIANTS.md) 第 22 条。

## 1. 决策顺序

1. **web-ide CSS**（`packages/web-ide/src/styles.css`）：只被 IDE 入口加载，桌面端与独立 Web 天然不受影响，不计入官方补丁预算。
2. **`isIdeHost()` 门控**：目标在 React 里有分支、需要停掉渲染或行为，且 CSS 选择器无法稳定命中。
3. **官方源码逻辑改动**：React 初始化路径、state、server 数据、必须在启动前生效的行为。

能停在 1 就不要走到 2。CSS 的选择器质量决定它是否可维护，先用下一节的判据确认。

## 2. CSS 选择器可行性判据

| 可用的钩子 | 示例 | 结论 |
|---|---|---|
| `data-testid` | `[data-testid="sidebar-primary-navigation"]`、`[data-testid="task-new-button"]` | **首选**，上游 e2e 也在用，改名的可能性低 |
| 单一规则产出的类名 | `pl-38` / `pl-44` 只由 `resolveTopOverlayLeadingPaddingClass` 产出 | 可用；注释里写清"这两个类来自哪里" |
| 容器名 / 组件根标识 | 顶部浮层根节点的 `[class*="topoverlayer"]` | 可用但偏脆；失效表现是元素重新出现，可见可查 |
| 本地化文案 | `[aria-label="新建任务"]` | **不要**，切英文就失效 |
| 匿名包装层的工具类 / 长 `:has()` 链 | `div:has(> button…)`、`.w-7.opacity-100` | **不要**，上游一改 DOM 就散架，维护成本高于 1 行门控 |

判断口诀：**选择器依赖"稳定的语义钩子"就用 CSS；依赖"当前 DOM 形状"就用门控。**

## 3. 隐藏入口后必须检查的四类连带占位

这是三次返工的直接来源，逐个确认再收工：

1. **父容器 padding/margin**：子项隐藏 ≠ 容器收起。侧栏三个导航入口全部隐藏后，`sidebar-primary-navigation` 仍留 `py-3` 的空白 → 连容器一起隐藏。
2. **为浮层让位的 padding/inset**：删掉绝对定位浮层后，header / Side Pane tab 栏仍按它预留 `pl-38`（152px）→ 同一份 CSS 清零。
3. **固定高度/间隔条**：`h-*`、`gap-*`、分隔线常由父级承担，隐藏子项后仍在。
4. **祖先的 `overflow` / `justify-between`**：隐藏一侧后，另一侧可能被推到边缘；需要顺带确认对齐。

整块入口都无关时，**优先隐藏容器而不是逐个隐藏子项**：规则更少，也不会留下空壳。

## 4. 验证流程（别只看"构建通过"）

1. 前端改动：`pnpm --filter @zcode/web-ide build` → `node scripts/build-runtime.mjs` → `./gradlew buildPlugin`（顺序不能颠倒）。
2. 看日志 `Starting ZCode server … web=`，确认这次验证的是**仓库 dist** 还是**插件目录 `runtime/web`**。
3. **刷新 JCEF 页面不要相信 `location.reload()` / `location.replace()`**：实测可能仍加载旧 bundle。用 CDP `Page.navigate` 带 cache-buster query，然后读 `<script src>` 的 hash 确认换成了新产物。
4. 两种状态都要量：侧栏展开 / 收起各读一次 `getComputedStyle(el).paddingLeft`、`display`、`offsetWidth`。只测一种状态会漏掉条件类。
5. 截图兜底：窗口最小化时 `ide-capture.ps1` 会截到 `-16000` 的空白图，先 `ShowWindow(hwnd, 9)` 恢复；临时 `.ps1` 用 ASCII（PowerShell 5.1 读无 BOM 的 UTF-8 中文会解析失败）。
6. 记账：`node scripts/patch-budget.mjs --worktree`；未提交时工作区口径与 HEAD 口径会不同，`CHANGES-VS-UPSTREAM.md` 要写清是哪一个。

## 5. 本次案例复盘

| 现象 | 根因 | 最终做法 |
|---|---|---|
| 侧栏收起后左上角残留新建图标 | 浮层按 `!isSidebarVisible` 渲染桌面端的新建入口 | CSS 隐藏整个浮层根节点（IDE 里浮层没有任何可用入口） |
| 侧栏顶部空白占位 | 入口逐个隐藏后容器 `py-3` 仍在 | CSS 隐藏 `sidebar-primary-navigation` 容器 |
| 会话标题左侧 152px 空白 | 浮层让位规则 `pl-38` 仍生效 | CSS 清零 `pl-38` / `pl-44` |
| 拖拽分割线悬停只有浅灰、没有品牌蓝 | 高亮靠 `platform-*-desktop:after:bg-resize-handle`，平台 class 由 Electron 入口挂载，IDE 入口没有 | 只补 `::after` 背景色（`[data-testid="resizable-handle"]` + `[data-separator]`），不改平台语义 |

走过的弯路：

- 先给 `DesktopTopOverlay` 加 `!ideHost`、再给 `resolveTopOverlayLeadingPaddingClass` 加 `isIdeHost()`——都能工作，但增加了官方源码补丁面；确认 CSS 可行后全部还原，官方修改文件从 23 降到 22。
- 只隐藏 `task-new-button` 而没看父容器，导致"按钮没了但空间还在"，多返工一轮。
- 曾考虑在 web-ide 入口直接挂 `platform-windows-desktop` 来复用桌面端高亮：同一个 variant 还控制窗口控制按钮、标题栏安全区与图片预览浮层偏移，会带出一串 IDE 里不该出现的元素，最后只抄了颜色。

## 6. 不要做

- 不要按调用点逐个铺 CSS；先找能一次覆盖的容器或共享类。
- 不要用文案/语言相关的属性做选择器。
- 不要把 `display:none` 当成"父容器也消失"。
- 不要为了让一两条桌面端样式生效就挂 `platform-*-desktop`：这三个 variant 是"桌面 chrome 在场"的语义开关，不止拖拽线高亮。
- 不要在 IDE 里恢复桌面浮层入口；IDE 的新建入口固定在头部右上角 ➕。
- 如果将来 IDE 确实需要浮层入口，先把它从"整块隐藏"里排除，并在本文补一条例外。
