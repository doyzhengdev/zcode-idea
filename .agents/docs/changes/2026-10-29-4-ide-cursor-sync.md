# 2026-10-29 · 插件侧补偿 JCEF 远程模式丢失的光标形状

- **范围**：插件 Kotlin（`src/main/kotlin/dev/zcode/ide/ui/ZCodePanel.kt`），不改官方源码
- **触发**：分割线高亮修好后用户实机反馈"左右拖拽的鼠标样式还是没出来"；根因见[第 3 篇](./2026-10-29-3-ide-splitter-hover-highlight.md)（JCEF out-of-process 不转发 `onCursorChange`）
- **提交**：working tree（未提交）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/main/kotlin/dev/zcode/ide/ui/ZCodePanel.kt` | 修改（+约 110 行） | 新增 `CURSOR_BY_CSS` 映射；新增独立 `JBCefJSQuery` 接收光标名并 `component.cursor = Cursor.getPredefinedCursor(...)`；`onLoadEnd` 注入 40ms 采样脚本；`teardownBrowser` 一并 dispose |

## 为什么改

JCEF 2026.2 的 out-of-process（remote-mode）把 CEF 放在独立进程，但代理层只转发 8 个
RenderHandler 调用，**没有 `RenderHandler_OnCursorChange`**；`CefBrowserOsr.onCursorChange`
在该模式下直接拒绝执行。结果是整页指针恒为默认箭头，CSS 与 DOM 都改不了。

可选方案只有两个：

1. 让用户关掉 IDE registry `ide.browser.jcef.out-of-process.enabled`——IDE 全局生效、需重启，
   影响 IDE 内所有 JCEF 内容，插件不该替用户改全局设置；
2. 面板侧补偿：页面把指针下元素的 `getComputedStyle(el).cursor` 上报，Kotlin 映射成 AWT
   预定义光标设到 JCEF 组件上。选的是这个——作用域只限 ZCode 面板，且不依赖前端产物版本。

## 实现要点

- **独立 `JBCefJSQuery`**，不接能力桥：光标是高频、无返回值的事件，走 `IdeBridge` 会白白占用
  RPC 通道并产生一次 `__zcodeIdeResolve` 回填。页面侧只多一个 `window.__zcodeIdeSetCursor(name)`。
- **采样策略**：`pointermove` 用 `requestAnimationFrame` 合并，并限制 40ms 一次；只有 cursor 名
  **变化**时才过桥。`pointerleave` / `window.blur` 复位为默认箭头。
- **映射**：`text|vertical-text → TEXT`、`pointer|hand|grab|grabbing|alias|copy|context-menu → HAND`、
  `crosshair|cell → CROSSHAIR`、`wait|progress → WAIT`、`move|all-scroll → MOVE`、
  `ew|col|e|w-resize → E/W_RESIZE`、`ns|row|n|s-resize → N/S_RESIZE`、
  `nwse/nesw` 四角 → 对应斜向；未列出的（`zoom-in`、`not-allowed`、`no-drop` 等）回退默认箭头。
- 生命周期：查询与浏览器一起在 `teardownBrowser()` 里 `Disposer.dispose`，页面重建时重新注入
  （脚本有 `window.__zcodeIdeCursorSync` 幂等守卫）。

## 行为变化

- IDE 面板内恢复指针形状：输入框 I-beam、链接/按钮 hand、分割线左右（`ew-resize`）与上下
  （`ns-resize`）、拖拽 `move` 等；光标在鼠标移出页面或窗口失焦时复位。
- 桌面客户端与独立 web 端不受影响（JCEF 专属逻辑）。
- 鼠标静止时页面 DOM 变化（例如弹层出现在指针下）不会触发更新，要等下一次移动；这是采样方案的
  已知边界，不影响拖拽/输入等交互。

## 验证

1. `JAVA_HOME=D:\apps\jdk\jdk-21.0.2 ./gradlew compileKotlin` / `buildPlugin` 均 BUILD SUCCESSFUL。
2. 部署：停 IDE → 备份并替换安装态 `plugins\zcode-ide\lib\zcode-ide-0.1.0.jar`
   （备份 `zcode-ide-0.1.0.jar.bak-20261029141327`，runtime 不动）→ 重启。
3. CDP 读页面：`typeof window.__zcodeIdeSetCursor === "function"`、`window.__zcodeIdeCursorSync === true`，
   说明新 jar 已加载且脚本注入成功。
4. **用户实机确认光标已恢复正常显示**（本次结论以实机为准，未再走 Win32 指针句柄比对）。

## 风险 / 后续

- JetBrains 若在后续版本补上 `RenderHandler_OnCursorChange` 转发，这套补偿可以整段删除；即使保留，
  两边设置的是同一个光标，不冲突。
- 映射表是 CSS 光标名的子集，新增名字（如 `zoom-in`）只会回退默认箭头，不会报错。
- `pointermove` 采样会每 40ms 调一次 `elementFromPoint` + `getComputedStyle`，开销可忽略；若将来
  页面出现高频重绘导致卡顿，可把采样间隔调大。
- 该补偿同样能覆盖终端、预览等面板里的光标，不只是分割线；它们是同一个页面。

## 相关

- 颜色修复：[第 3 篇](./2026-10-29-3-ide-splitter-hover-highlight.md)
- 交接文档：[`DEBUG-SPLITTER-CURSOR.md`](../development/DEBUG-SPLITTER-CURSOR.md)
- 差异清单：[`IDE-VS-DESKTOP.md`](../../architecture/IDE-VS-DESKTOP.md) §7
