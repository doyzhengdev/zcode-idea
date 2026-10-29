# 2026-10-29 · IDE 内分割线悬停高亮补成桌面端品牌蓝

- **范围**：`vendor/ZCode/packages/web-ide`（IDE 入口自有样式，不计官方补丁预算）
- **触发**：用户对比官方桌面客户端与 IDE 内嵌 web UI：侧栏右缘 / 面板之间的拖拽线在桌面端悬停是蓝色 + `<-->` 指针，IDE 里线很浅且指针不变（交接文档 [`DEBUG-SPLITTER-CURSOR.md`](../development/DEBUG-SPLITTER-CURSOR.md)）
- **提交**：working tree（未提交）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/web-ide/src/styles.css` | 修改（+11 行） | 新增 `html [data-separator]::after, html [data-testid="resizable-handle"]::after { background-color: var(--color-resize-handle) }` |

## 为什么改

两个独立问题：高亮在样式层修（本篇），cursor 是 JCEF 远程模式的能力缺口，插件侧另做补偿（[第 4 篇](./2026-10-29-4-ide-cursor-sync.md)）。

**一、高亮回退成浅灰（已修）。** 上游两条分割线（`WorkspaceShellLayout.tsx:2359` 的侧栏把手、`components/ui/resizable.tsx:17` 的 `react-resizable-panels` 分割线，终端面板的 `AnimatedTerminalPanel` 同款）默认都是
`after:bg-foreground-subtlest/50`，再靠 `platform-mac/windows/linux-desktop:after:bg-resize-handle` 换成品牌蓝。
三个平台 variant 由 Electron 入口挂到 `<html>`（`packages/desktop/src/renderer/src/main.tsx:109-116`），
web-ide 入口从不挂任何平台 class，所以 IDE 里永远命中不上，只剩 15% 透明度的浅灰。

**否决的方案**：在 web-ide 入口补 `platform-windows-desktop`。同一个 variant 还控制
`DesktopOverlayWindowControls.tsx:6`（`hidden` → `flex`，IDE 里会凭空出现窗口按钮）、
`WelcomeScreen.tsx:39`（标题栏拖拽安全区宽度）、`components/ai-elements/image-preview-dialog.tsx:430`
（Windows 下浮层按钮按 titlebar 高度下移）。为了 2 行背景色打开一整套桌面 chrome 语义不划算。

选择器依据：`data-testid="resizable-handle"` 是上游 e2e 也在引用的稳定钩子；`[data-separator]` 是
`react-resizable-panels@4.10.0` 固定输出的属性（`idle|hover|active|focus|disabled` 都会命中）。
`html` 前缀只为压过 Tailwind 同权重工具类（`(0,1,2)` > `(0,1,1)`），不用 `!important`。

## 行为变化

- IDE 内悬停侧栏把手、对话/终端/浏览器之间的分割线时，高亮线从 15% 灰变成与桌面端一致的品牌蓝（亮色 `sky-500` / 暗色 `sky-400`）。
- 桌面客户端与独立 web 端不受影响：该样式只在 web-ide 入口加载。
- cursor 形状由插件侧的同步补偿负责，见[第 4 篇](./2026-10-29-4-ide-cursor-sync.md)；本篇的样式改动不参与指针形状。

## 验证

1. `pnpm --filter @zcode/web-ide build` → 产物 `dist/assets/index-CRyN9CJx.css` 含该规则（minify 后写作 `html [data-separator]:after,html [data-testid=resizable-handle]:after{...}`），且位于工具类之后。
2. `node scripts/build-runtime.mjs` → `dist/` 173MB，`BUILD-INFO.json` 记录 `e6e011796127 (dirty)`。
3. **CDP 实页验证（生产页面 `127.0.0.1:49525`，当时仍加载旧的 `index-DEiPtweW.css`）**：把产物里的那条规则注入 `<style>` 后，对同一只侧栏把手 hover，`::after` 从 `oklab(0.87 0 0 / 0.15)` / `opacity 1` 变为 `oklch(0.746 0.16 232.661)`（暗色主题的 sky-400）；`--color-resize-handle` 解析为 `oklch(74.6% .16 232.661)`。
4. `JAVA_HOME=D:\apps\jdk\jdk-21.0.2 ./gradlew buildPlugin` BUILD SUCCESSFUL（默认薄包，不含 runtime）。
5. **部署（2026-10-29 14:0x，项目已迁到 `E:\work\doyzheng\zcode-ide`）**：安装态 `plugins\zcode-ide\runtime\web` 整目录替换为新 `dist/web`（旧目录备份为 `web.bak-20261029060404`），重启后页面加载 `index-UwPvWuJf.js` / `index-CRyN9CJx.css`；CDP 读 `::after` 为 `oklch(0.746 0.16 232.661)`、`opacity 1`，**用户在实机确认蓝线已出现**。
6. `node scripts/patch-budget.mjs --worktree`：修改 **19 / 预算 23**（本次改的是 `packages/web-ide`，不计入）。

## 为什么 cursor 不变（新证据，修正交接文档的旧结论）

交接文档推测"remote-mode 下实际创建 windowed browser"，反编译后不成立：

- `JBCefBrowserBuilder.setOffScreenRendering(false)` 在 remote-mode 下被忽略，强制 `myIsOffScreenRendering = true`（日志里的 warn 之后紧接着 `iconst_1; putfield myIsOffScreenRendering`）——即仍是 OSR 合成，指针形状只能来自 Java 侧的 `onCursorChange` → `Component.setCursor`。
- out-of-process 的代理 `com.jetbrains.cef.remote.ClientHandlersImpl`（`intellij.libraries.jcef.jar`）只转发 8 个 RenderHandler 调用：`GetViewRect`、`GetScreenInfo`、`GetScreenPoint`、`OnPaint`、`OnPopupShow`、`OnPopupSize`、`OnTextSelectionChanged`、`OnImeCompositionRangeChanged`——**没有 `RenderHandler_OnCursorChange`**（把 jar 里所有 `RenderHandler_*` 符号枚举过，thrift codegen 也在内）。
- jar 内还有一句自证：`onCursorChange mustn't be called in remote mode (it seems that user manually called this method)`。
- 运行期旁证：`EnumChildWindows(IDE 主窗口)` 只有 1 个非 Cef 子窗口，页面确实是 OSR 合成的；CDP 读到的 computed cursor 本身是正确的 `ew-resize`。

结论：这是 JCEF 远程模式的能力缺口，**整页** cursor 形状都不跟随（输入框 I-beam、链接 hand 同样不生效），不是分割线专属，插件侧改 CSS/DOM 都无效。
临时恢复可以关掉 IDE registry `ide.browser.jcef.out-of-process.enabled`（IDE 全局 + 需重启），但插件不该替用户改全局设置——实际采用的是面板侧补偿，见[第 4 篇](./2026-10-29-4-ide-cursor-sync.md)。

## 风险 / 后续

- 前端产物这次是以"替换安装态 `runtime/web` + 重启 IDE"的方式落地的（server 侧选了仓库布局，`web=E:\work\doyzheng\zcode-ide\vendor\ZCode\packages\web-ide\dist`）；以后走完整部署时仍按 [deploy skill](../../skills/deploy-zcode-plugin/SKILL.md) 打 `-PbundleRuntime=true` 全量包，避免后端与前端版本错位。
- `check-change-log` 对纯 vendor 改动不可见（fork 独立仓库），以本记录为准。
- 上游若换掉分割线实现（改库或去掉 `data-separator`），规则失效的表现是"又变回浅灰"，用 CDP 读 `::after` 背景色即可确认。
- cursor 差异已记入 [`IDE-VS-DESKTOP.md`](../../architecture/IDE-VS-DESKTOP.md) §7；JetBrains 修复该转发后可整段删除本节的定性。

## 相关

- 交接文档：[`DEBUG-SPLITTER-CURSOR.md`](../development/DEBUG-SPLITTER-CURSOR.md)
- CSS 操作手册：[`IDE-UI-TRIMMING.md`](../development/IDE-UI-TRIMMING.md)
- 差异清单：[`IDE-VS-DESKTOP.md`](../../architecture/IDE-VS-DESKTOP.md)
