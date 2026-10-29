package dev.zcode.ide.ui

import com.intellij.ide.ui.LafManager
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CustomShortcutSet
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import dev.zcode.ide.bridge.IdeBridge
import dev.zcode.ide.runtime.RuntimeUpdater
import dev.zcode.ide.service.ZCodeIdeService
import dev.zcode.ide.service.ZCodeServerManager
import kotlinx.serialization.json.JsonPrimitive
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import java.awt.BorderLayout
import java.awt.Cursor
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Locale
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.KeyStroke
import javax.swing.SwingConstants

/**
 * 页面 `cursor` 计算值 → AWT 预定义光标。
 *
 * JCEF 在 out-of-process（remote-mode）下虽然仍走 OSR 合成，但代理层不转发 CEF 的
 * `RenderHandler.onCursorChange`，Java 侧永远收不到光标回调，整页指针恒为默认箭头
 * （文本 I-beam、链接 hand、分割线 ew-resize 都不生效）。CSS 无解，只能在面板侧补：
 * 页面把指针下元素的 cursor 名送回来，这里映射成 AWT 光标设到 JCEF 组件上。
 * 未列出的值（zoom-in / not-allowed / no-drop 等）回退默认箭头。
 */
private val CURSOR_BY_CSS: Map<String, Int> = mapOf(
    "text" to Cursor.TEXT_CURSOR,
    "vertical-text" to Cursor.TEXT_CURSOR,
    "pointer" to Cursor.HAND_CURSOR,
    "hand" to Cursor.HAND_CURSOR,
    "grab" to Cursor.HAND_CURSOR,
    "grabbing" to Cursor.HAND_CURSOR,
    "alias" to Cursor.HAND_CURSOR,
    "copy" to Cursor.HAND_CURSOR,
    "context-menu" to Cursor.HAND_CURSOR,
    "crosshair" to Cursor.CROSSHAIR_CURSOR,
    "cell" to Cursor.CROSSHAIR_CURSOR,
    "wait" to Cursor.WAIT_CURSOR,
    "progress" to Cursor.WAIT_CURSOR,
    "move" to Cursor.MOVE_CURSOR,
    "all-scroll" to Cursor.MOVE_CURSOR,
    "ew-resize" to Cursor.E_RESIZE_CURSOR,
    "col-resize" to Cursor.E_RESIZE_CURSOR,
    "e-resize" to Cursor.E_RESIZE_CURSOR,
    "w-resize" to Cursor.W_RESIZE_CURSOR,
    "ns-resize" to Cursor.N_RESIZE_CURSOR,
    "row-resize" to Cursor.N_RESIZE_CURSOR,
    "n-resize" to Cursor.N_RESIZE_CURSOR,
    "s-resize" to Cursor.S_RESIZE_CURSOR,
    "nwse-resize" to Cursor.NW_RESIZE_CURSOR,
    "nw-resize" to Cursor.NW_RESIZE_CURSOR,
    "se-resize" to Cursor.SE_RESIZE_CURSOR,
    "nesw-resize" to Cursor.NE_RESIZE_CURSOR,
    "ne-resize" to Cursor.NE_RESIZE_CURSOR,
    "sw-resize" to Cursor.SW_RESIZE_CURSOR,
)

/**
 * ZCode ToolWindow 面板：JCEF 加载官方 Web UI，并把 IDE 能力通过 JBCefJSQuery 暴露给页面。
 */
class ZCodePanel(private val project: Project) : JPanel(BorderLayout()), Disposable {

    private val log = Logger.getInstance("ZCodeIDE")
    private val bridge = IdeBridge(project)

    private var browser: JBCefBrowser? = null
    private var query: JBCefJSQuery? = null

    /** 光标同步专用查询：与能力桥分离，避免把高频、无返回值的事件塞进 RPC 通道。 */
    private var cursorQuery: JBCefJSQuery? = null

    /**
     * 共享 server 重启后由 [ZCodeServerManager] 在 EDT 广播，面板重建页面。
     * 广播与正在进行的启动流程并发时靠 [teardownBrowser] 防止泄漏旧的 JCEF 实例。
     */
    private val reloadListener: () -> Unit = {
        if (!disposed && !project.isDisposed) {
            removeAll()
            createBrowser()
        }
    }
    private val lafListener = object : LafManagerListener {
        override fun lookAndFeelChanged(source: LafManager) = applyTheme()
    }

    /** 组件级快捷键优先于全局 keymap，用来吞掉会隐藏工具窗口的 Ctrl+W。 */
    private val swallowCtrlW = object : AnAction() {
        override fun actionPerformed(e: AnActionEvent) = Unit
    }

    /** 页面加载完成前执行 JS 会落到 about:blank，等 onLoadEnd 再同步主题。 */
    @Volatile
    private var pageLoaded = false

    /** 面板已销毁：后台启动/下载回调不能再碰 Swing 组件。 */
    @Volatile
    private var disposed = false

    /** IDE → JS 的待推送消息；页面加载完成前排队，onLoadEnd 后冲刷。 */
    private val pendingPushes = ArrayDeque<String>()

    init {
        ZCodeServerManager.getInstance().addReloadListener(reloadListener)
        if (!JBCefApp.isSupported()) {
            showMessage("当前 IDE 未启用 JCEF，无法显示 ZCode。")
        } else {
            // 官方 UI 的主题由根节点 dark class 决定，跟随 IDE 的 LAF 切换。
            // 连接绑定到 this，面板销毁时自动取消订阅。
            ApplicationManager.getApplication().messageBus.connect(this)
                .subscribe(LafManagerListener.TOPIC, lafListener)
            ApplicationManager.getApplication().invokeLater { createBrowser() }
        }
    }

    private fun createBrowser() {
        if (!JBCefApp.isSupported()) {
            showMessage("当前 IDE 未启用 JCEF，无法显示 ZCode。")
            return
        }
        showMessage("正在检查 Node 运行时…")

        // 首次启动可能要从镜像下载 Node 24（几十 MB），必须离开 EDT；
        // 下载/解压/启动 server 的进度通过 status 回显到面板。
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = runCatching {
                ZCodeIdeService.getInstance(project).url { text ->
                    ApplicationManager.getApplication().invokeLater {
                        if (!disposed && !project.isDisposed) showMessage(text)
                    }
                }
            }
            ApplicationManager.getApplication().invokeLater {
                if (disposed || project.isDisposed) return@invokeLater
                result.onSuccess { base -> setupBrowser(base) }
                    .onFailure { t ->
                        log.warn("ZCode server start failed", t)
                        showError(t.message ?: t.toString())
                    }
            }
        }
    }

    private fun setupBrowser(base: String) {
        // reload 广播可能与正在进行的启动流程并发（例如别的窗口重启 server），
        // 先拆掉旧实例再建新的，否则前一个 JBCefBrowser 会泄漏。
        teardownBrowser()

        val locale = if (Locale.getDefault().language == "zh") "zh-CN" else "en-US"
        // 项目路径随 URL 传给前端：全 IDE 共用一个 server，前端靠它锁定本窗口的项目。
        // bindWorkspaceProject 会做服务端路径规范化，这里传 IDE 原始路径即可。
        val workspace = project.basePath ?: System.getProperty("user.home")
        val encodedWorkspace = URLEncoder.encode(workspace, StandardCharsets.UTF_8)
        // ideHost 让前端知道当前是 IDE 内嵌形态（侧栏与头部会做精简）。
        val url = "$base&ideWorkspace=$encodedWorkspace&ideLocale=$locale&ideTheme=${currentTheme()}&ideHost=1"

        try {
            val cefBrowser = JBCefBrowser()
            val jsQuery = JBCefJSQuery.create(cefBrowser as JBCefBrowserBase)

            // 光标名是高频、无返回值的事件，单独开一条查询：不进能力桥的 RPC 通道，
            // 也不需要 __zcodeIdeResolve 回填。
            val cursorQuery = JBCefJSQuery.create(cefBrowser as JBCefBrowserBase)
            cursorQuery.addHandler { request ->
                val type = CURSOR_BY_CSS[request.trim().lowercase(Locale.ROOT)] ?: Cursor.DEFAULT_CURSOR
                ApplicationManager.getApplication().invokeLater {
                    if (!disposed && !project.isDisposed) {
                        cefBrowser.component.cursor = Cursor.getPredefinedCursor(type)
                    }
                }
                JBCefJSQuery.Response("ok")
            }

            jsQuery.addHandler { request ->
                // 文件对话框会阻塞等待用户选择，必须放到后台线程；否则会卡住 CEF 回调线程。
                ApplicationManager.getApplication().executeOnPooledThread {
                    val result = bridge.handle(request)
                    val payload = if (result.ok) {
                        result.payload?.toString() ?: "null"
                    } else {
                        result.error ?: "unknown error"
                    }
                    val script =
                        "window.__zcodeIdeResolve(${result.id}, ${result.ok}, ${JsonPrimitive(payload)})"
                    cefBrowser.cefBrowser.executeJavaScript(script, "zcode-ide-bridge", 0)
                }
                JBCefJSQuery.Response("ok")
            }

            cefBrowser.setOpenLinksInExternalBrowser(true)
            // Ctrl+W 会被 IDE 解释为隐藏当前工具窗口；在这里注册一个空动作覆盖它，
            // 避免用户误按一次就把 ZCode 面板关掉。
            swallowCtrlW.registerCustomShortcutSet(
                CustomShortcutSet(KeyStroke.getKeyStroke("control W")),
                cefBrowser.component,
                this,
            )
            cefBrowser.jbCefClient.addLoadHandler(
                object : CefLoadHandlerAdapter() {
                    override fun onLoadEnd(
                        browser: CefBrowser?,
                        frame: CefFrame?,
                        httpStatusCode: Int,
                    ) {
                        if (frame?.isMain == true) {
                            injectBridge(cefBrowser, jsQuery, cursorQuery)
                            pageLoaded = true
                            applyTheme()
                            drainPendingPushes()
                        }
                    }
                },
                cefBrowser.cefBrowser,
            )

            cefBrowser.loadURL(url)
            browser = cefBrowser
            query = jsQuery
            this.cursorQuery = cursorQuery

            // 注册为活动面板：右键菜单等 IDE 入口从这里把消息推进 webview。
            val service = ZCodeIdeService.getInstance(project)
            service.panel = this
            service.takeQueuedWebviewMessages().forEach { pushToWebview(it) }

            removeAll()
            add(cefBrowser.component, BorderLayout.CENTER)
            revalidate()
            repaint()
            log.info("ZCode webview loaded: $url")
            // 浏览器就绪后顺手触发一次运行时更新检查（不阻塞加载；
            // 幂等由 RuntimeUpdater 的 24h 节流 + 并发防御保证，无需去重）。
            fireRuntimeUpdateCheck()
        } catch (t: Throwable) {
            log.warn("Failed to create JCEF browser", t)
            showError(t.message ?: t.toString())
        }
    }

    /** 浏览器就绪路径上的一次性触发：pooled thread 跑一次普通检查（不强制、不阻塞加载），异常吞掉记日志。 */
    private fun fireRuntimeUpdateCheck() {
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching { RuntimeUpdater.checkInBackground() }
                .onFailure { log.warn("Runtime update check after browser ready failed", it) }
        }
    }

    private fun injectBridge(
        cefBrowser: JBCefBrowser,
        jsQuery: JBCefJSQuery,
        cursorQuery: JBCefJSQuery,
    ) {
        // JBCefJSQuery 注入的函数只接受 `{ request: string }` 这一个对象参数；直接传裸 JSON
        // 字符串会抛 "Invalid arguments; expecting a single object"，页面侧所有调用都会静默失败。
        // 这里包一层，让前端保持 query(json) 的简单签名。
        val script = """
            window.__ZCODE_IDE_QUERY__ = (json) => window['${jsQuery.funcName}']({ request: json });
            window.__zcodeIdeSetCursor = (name) => window['${cursorQuery.funcName}']({ request: name });
        """.trimIndent()
        cefBrowser.cefBrowser.executeJavaScript(script, "zcode-ide-inject", 0)

        // 光标同步：remote-mode 下 CEF 的 onCursorChange 不会到 Java 侧（见 CURSOR_BY_CSS 注释），
        // 由页面自己上报指针下元素的计算 cursor。pointermove 采样降到 40ms，且值不变不发送，
        // 避免鼠标移动时持续过桥。
        val cursorScript = """
            (() => {
              if (window.__zcodeIdeCursorSync) return;
              window.__zcodeIdeCursorSync = true;
              let last = null;
              let frame = 0;
              let sampledAt = 0;
              const send = (name) => {
                const next = name || 'default';
                if (next === last) return;
                last = next;
                try { window.__zcodeIdeSetCursor(next); } catch (e) {}
              };
              const sample = (x, y) => {
                frame = 0;
                const el = document.elementFromPoint(x, y);
                send(el ? getComputedStyle(el).cursor : 'default');
              };
              document.addEventListener('pointermove', (event) => {
                const now = Date.now();
                if (frame || now - sampledAt < 40) return;
                sampledAt = now;
                const x = event.clientX;
                const y = event.clientY;
                frame = requestAnimationFrame(() => sample(x, y));
              }, { passive: true, capture: true });
              document.addEventListener('pointerleave', () => send('default'), { passive: true });
              window.addEventListener('blur', () => send('default'));
            })();
        """.trimIndent()
        cefBrowser.cefBrowser.executeJavaScript(cursorScript, "zcode-ide-cursor", 0)
    }

    /**
     * IDE → JS：把一条 JSON 消息推给页面（`window.__zcodeIdeMessage`）。
     * 页面未加载完成时先排队，由 onLoadEnd 冲刷；JCEF 不在手时静默保留。
     */
    fun pushToWebview(json: String) {
        synchronized(pendingPushes) { pendingPushes.add(json) }
        drainPendingPushes()
    }

    private fun drainPendingPushes() {
        val cefBrowser = browser ?: return
        if (!pageLoaded) return
        val messages = synchronized(pendingPushes) {
            if (pendingPushes.isEmpty()) return
            val drained = pendingPushes.toList()
            pendingPushes.clear()
            drained
        }
        ApplicationManager.getApplication().invokeLater {
            for (json in messages) {
                // JsonPrimitive 生成带转义的 JS 字符串字面量，避免手拼转义。
                runCatching {
                    cefBrowser.cefBrowser.executeJavaScript(
                        "window.__zcodeIdeMessage && window.__zcodeIdeMessage(${JsonPrimitive(json)})",
                        "zcode-ide-push",
                        0,
                    )
                }.onFailure { log.warn("pushToWebview failed: ${it.message}") }
            }
        }
    }

    private fun currentTheme(): String = if (JBColor.isBright()) "light" else "dark"

    /**
     * 把 IDE 当前的明暗主题写进官方 UI 的 `zcode-theme` 存储并同步根节点 class，
     * 与 @zcode/ui 的 applyTheme 保持一致（dark / theme-zai-* / browser-theme-surface）。
     */
    private fun applyTheme() {
        if (!pageLoaded) return
        val cefBrowser = browser ?: return
        val dark = currentTheme() == "dark"
        val script = """
            (() => {
              try {
                const dark = $dark;
                localStorage.setItem('zcode-theme', dark ? 'zai-dark' : 'zai-light');
                const root = document.documentElement;
                root.classList.toggle('dark', dark);
                root.classList.toggle('theme-zai-dark', dark);
                root.classList.toggle('theme-zai-light', !dark);
                root.setAttribute('data-zcode-browser-theme-surface', dark ? 'dark' : 'light');
                root.style.colorScheme = dark ? 'dark' : 'light';
              } catch (e) {}
            })();
        """.trimIndent()
        cefBrowser.cefBrowser.executeJavaScript(script, "zcode-ide-theme", 0)
    }

    private fun showMessage(message: String) {
        removeAll()
        add(JLabel(message, SwingConstants.CENTER), BorderLayout.CENTER)
        revalidate()
    }

    private fun showError(message: String) {
        removeAll()
        val retry = JButton("重试").apply {
            addActionListener {
                // 存活探测与重启都可能抢 manager 的启动锁或做网络探测，整体放后台线程。
                ApplicationManager.getApplication().executeOnPooledThread {
                    val service = ZCodeIdeService.getInstance(project)
                    if (!service.isServerAlive()) {
                        // server 已挂：重启并广播，所有窗口的面板（含本面板）都会重建。
                        service.restart()
                    } else {
                        // server 活着，只是本页面坏了：仅重建本窗口，不重载其他项目窗口。
                        ApplicationManager.getApplication().invokeLater {
                            if (!disposed && !project.isDisposed) {
                                removeAll()
                                createBrowser()
                            }
                        }
                    }
                }
            }
        }
        val text = JLabel("<html><div style='padding:12px'>ZCode 启动失败：<br>${escape(message)}</div></html>")
        val panel = JPanel(BorderLayout())
        panel.add(text, BorderLayout.CENTER)
        panel.add(retry, BorderLayout.SOUTH)
        add(panel, BorderLayout.CENTER)
        revalidate()
    }

    private fun escape(value: String): String =
        value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    /** 拆掉现有 JCEF 实例（dispose 或重建前调用），防止并发重建时泄漏。 */
    private fun teardownBrowser() {
        runCatching { query?.let { Disposer.dispose(it) } }
        runCatching { cursorQuery?.let { Disposer.dispose(it) } }
        runCatching { browser?.let { Disposer.dispose(it) } }
        query = null
        cursorQuery = null
        browser = null
        pageLoaded = false
    }

    override fun dispose() {
        disposed = true
        runCatching { ZCodeServerManager.getInstance().removeReloadListener(reloadListener) }
        runCatching { ZCodeIdeService.getInstance(project).releasePanel(this) }
        teardownBrowser()
    }
}
