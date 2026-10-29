# 排查交接：IDE 内分割拖拽线颜色浅、无 resize 鼠标样式

> 状态：**两项都已修复并部署验证**——高亮色（web-ide 自有样式）与 cursor（插件侧采样补偿）。
> 触发：用户对比官方桌面客户端与 IDE 内嵌 web UI，发现侧栏与中间区域之间的拖拽分割线，
> 官方端悬停显示蓝色高亮线 + `<-->` 鼠标指针；IDE 端线很浅且无鼠标指针变化。
> 截图：会话 image-cache `image-01783125cadeda51da17b3c0a2209354.png`。
> 落地记录：[颜色](../changes/2026-10-29-3-ide-splitter-hover-highlight.md)、[光标](../changes/2026-10-29-4-ide-cursor-sync.md)。

## 1. 涉及的分割线是哪两条

IDE 内嵌页面里用户看到的拖拽线来自两套实现（都在 `@zcode/ui`，非我们代码）：

| 位置 | 实现 | cursor 来源 | 悬停高亮来源 |
|---|---|---|---|
| 侧栏右缘（截图左侧） | `packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2350-2369`（手写 `role="separator"` 把手，`w-1` 命中区） | Tailwind 类 `cursor-ew-resize` | `after:` 伪元素 `bg-foreground-subtlest/50`（灰）；**仅桌面端**换 `bg-resize-handle`（蓝） |
| 中间区域各面板之间 | `packages/ui/src/components/ui/resizable.tsx` 的 `ResizableHandle` → `react-resizable-panels` 的 `Separator` | **库 inline style `cursor: P`**（`col-resize`/`row-resize`），不依赖 class | 同上 `after:` 伪元素 + `hover:bg-border-hover/60` |

官方组件 `WorkbenchSplitDivider.tsx`（分屏预览的分割线）是第三套，本问题不涉及。

高亮颜色的关键变量（`packages/ui/src/styles.css`）：
- `@custom-variant platform-windows-desktop` 等三个平台变体（41 行附近）；
- `--color-resize-handle: var(--color-sky-500)` / `sky-400`（亮/暗主题，`@theme` 与 `.dark`）——即官方端悬停的蓝色。

## 2. 根因一：悬停高亮回退成浅灰（已修）

`WorkspaceShellLayout.tsx:2359` 与 `resizable.tsx:17` 的高亮类都是：

```
after:bg-foreground-subtlest/50                       ← 默认（浅灰）
platform-*-desktop:after:bg-resize-handle             ← 桌面端（蓝色）
```

平台 class 由**各入口自行挂载**：
- 官方桌面端：`packages/desktop/src/renderer/src/main.tsx:107-115`，
  `document.documentElement.classList.toggle("platform-windows-desktop", isWindowsDesktop)`；
- 我们的 web-ide 入口：`packages/web-ide/src/main.tsx` **没有挂任何平台 class**。

结论：IDE 里 `platform-windows-desktop:...` 规则永远不命中，悬停只剩
`bg-foreground-subtlest/50`。CDP 实测 hover 时 `::after` = `oklab(0.87 0 0 / 0.15)`、`opacity: 1`，
与"很浅"的观感一致——这是**平台标记缺失**，不是样式被删（产物 CSS 里
`.cursor-ew-resize`、`--color-resize-handle`、`bg-foreground-subtlest/50` 都在）。

**不能无脑挂平台 class**：`platform-windows-desktop` 同时控制窗口控制按钮
（`DesktopOverlayWindowControls.tsx:6`）、标题栏安全区（`WelcomeScreen.tsx:39`、`image-preview-dialog.tsx:430`）
等，IDE 里会凭空出现按钮/错位。

修复做法（已落地）：在 `packages/web-ide/src/styles.css` 只补颜色本身——

```css
html [data-separator]::after,
html [data-testid="resizable-handle"]::after {
  background-color: var(--color-resize-handle);
}
```

覆盖侧栏把手 + 所有 `react-resizable-panels` 分割线（含终端面板）。
验证：把产物里的这条规则注入生产页面后，同一只把手 hover 的 `::after` 从
`oklab(0.87 0 0 / 0.15)` 变为 `oklch(0.746 0.16 232.661)`（暗色 sky-400）。

## 3. 根因二：cursor 不生效——JCEF out-of-process 不转发光标回调

（本节修正了初版结论："remote-mode 下创建 windowed browser"是误读日志。）

CSS 层证据已闭合：侧栏把手的 computed `cursor` 就是 `ew-resize`（CDP 实测），产物里也有
`.cursor-ew-resize`；中间区域由库在 hover 时往 `adoptedStyleSheets` 注入
`*, *:hover {cursor: ew-resize !important}`。所以问题不在 CSS。

JCEF 侧（`plugins/jcef-plugin/lib/modules/*.jar` 反编译）：

1. remote-mode 下 `JBCefBrowserBuilder.setOffScreenRendering(false)` 被忽略，
   强制 `myIsOffScreenRendering = true` → 仍是 **OSR 合成**，指针形状只能靠
   `JBCefOsrHandler.onCursorChange` → `Component.setCursor`。
2. out-of-process 代理 `com.jetbrains.cef.remote.ClientHandlersImpl` 只转发 8 个
   RenderHandler 调用（`GetViewRect` / `GetScreenInfo` / `GetScreenPoint` / `OnPaint` /
   `OnPopupShow` / `OnPopupSize` / `OnTextSelectionChanged` / `OnImeCompositionRangeChanged`），
   **没有 `RenderHandler_OnCursorChange`**（thrift codegen 里也没有）。
3. jar 内有自证字符串：`onCursorChange mustn't be called in remote mode …`。
4. 运行期旁证：`EnumChildWindows(IDE 主窗口)` 只有 1 个非 Cef 子窗口，页面确实是 OSR 的。

结论：**整页** cursor 形状都不跟随（输入框 I-beam、链接 hand 同样不生效），
不是分割线专属，改 CSS/DOM 都无法修复。全局开关只有关掉 IDE registry
`ide.browser.jcef.out-of-process.enabled`（IDE 全局 + 需重启），插件不该替用户改；
实际采用的是面板侧补偿，见 §4。

## 4. 修复落地

**高亮色**：`packages/web-ide/src/styles.css` 补一条 `html [data-separator]::after,
html [data-testid="resizable-handle"]::after { background-color: var(--color-resize-handle) }`，
不挂 `platform-*-desktop`（会带出窗口按钮/标题栏安全区/图片预览浮层偏移）。

**cursor**：`ZCodePanel.kt` 里开一条独立 `JBCefJSQuery`，`onLoadEnd` 注入采样脚本——
`pointermove` 按 40ms 采样 `elementFromPoint` 的 `getComputedStyle().cursor`，值变化才回传，
Kotlin 映射成 AWT 预定义光标设到 JCEF 组件；`pointerleave` / `window.blur` 复位默认箭头。
映射覆盖 text / pointer / move / resize 四向 / crosshair / wait，未列出的回退箭头。

**部署方式**：前端替换安装态 `runtime/web`（备份 `web.bak-20261029060404`）；
Kotlin 替换安装态 `lib/zcode-ide-0.1.0.jar`（备份 `zcode-ide-0.1.0.jar.bak-20261029141327`）；
两次都重启 IDE。验证：CDP 读到 `__zcodeIdeSetCursor` 已注入、`::after` 为 sky-400；
**用户在实机确认蓝线与光标都正常显示**。

## 5. 复现 / 验证环境速查

- IDE 安装：`C:\Program Files\JetBrains\IntelliJ IDEA 2026.2.2`
- 日志：`C:\Users\<user>\AppData\Local\JetBrains\IntelliJIdea2026.2\log\idea.log`
- JCEF 模块：`plugins/jcef-plugin/lib/modules/intellij.platform.ui.jcef.jar`
  （`JBCefOsrHandler` / `JBCefBrowserBuilder`）与
  `intellij.libraries.jcef.jar`（`com.jetbrains.cef.remote.*` 代理与 thrift）
- web-ide 产物：`vendor/ZCode/packages/web-ide/dist/assets/index-*.css`
- 官方桌面对照：`vendor/ZCode/packages/desktop/src/renderer/src/main.tsx:107-115`
- 部署流程：`.agents/skills/deploy-zcode-plugin/SKILL.md`
