package dev.zcode.ide.service

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import dev.zcode.ide.ui.ZCodePanel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.nio.file.Paths

/**
 * 项目级服务：面板注册与 IDE→Web 消息队列。
 *
 * server 本身是全 IDE 共享的应用级单例（[ZCodeServerManager]），项目路径通过 webview URL 的
 * `ideWorkspace` 参数传入，这里不再持有进程。
 */
@Service(Service.Level.PROJECT)
class ZCodeIdeService(private val project: Project) : Disposable {

    /** 当前挂载的 ZCode 面板；右键菜单等 IDE 入口通过它向 webview 推消息。 */
    @Volatile
    internal var panel: ZCodePanel? = null

    /**
     * 工具窗口尚未创建（或页面还没注册）时暂存的 webview 消息，面板挂载后按顺序取走。
     * 用队列而不是单槽：连续两次「发送到对话框」不能把前一条覆盖掉。
     */
    private val queuedWebviewMessages = ArrayDeque<String>()

    /**
     * 启动（或复用）全 IDE 共享的 ZCode server。
     *
     * **必须在后台线程调用**：首次启动可能需要下载 Node 24，调用方用 [status] 把进度
     * （下载/解压/启动）回显到面板，并自行切回 EDT。
     */
    fun url(status: (String) -> Unit = {}): String =
        ZCodeServerManager.getInstance()
            .url(status, legacyWorkspace = project.basePath?.let(Paths::get))

    /** 共享 server 是否可用（可能在后台线程做一次本地探测）。 */
    fun isServerAlive(): Boolean = ZCodeServerManager.getInstance().isAlive()

    /** 重启共享 server：所有窗口的面板会被通知重建。**必须在后台线程调用**。 */
    fun restart() = ZCodeServerManager.getInstance().restart()

    /**
     * 把选中的文件/目录引用添加到 ZCode 对话（项目树等处的右键菜单入口）。
     * 打开工具窗口后经 `window.__zcodeIdeMessage` 推给页面，页面负责插入 composer。
     */
    fun sendPathsToComposer(files: List<Pair<String, Boolean>>) {
        if (files.isEmpty()) return
        val message = buildJsonObject {
            put("op", "filesToInput")
            put(
                "refs",
                JsonArray(files.map { (path, directory) ->
                    buildJsonObject {
                        put("path", path)
                        put("kind", if (directory) "directory" else "file")
                    }
                }),
            )
            put("source", "menu")
        }.toString()
        deliverToWebview(message)
    }

    /**
     * 把编辑器选区添加到 ZCode 对话（编辑器右键入口）。
     * 与文件引用共用推送通道；只带路径与行号，不带选中原文——模型可以按行号自己读文件。
     */
    fun sendSelectionToComposer(
        path: String,
        startLine: Int,
        endLine: Int,
    ) {
        val message = buildJsonObject {
            put("op", "selectionToInput")
            put(
                "refs",
                JsonArray(
                    listOf(
                        buildJsonObject {
                            put("path", path)
                            put("kind", "file")
                            put("startLine", startLine)
                            put("endLine", endLine)
                        },
                    ),
                ),
            )
            put("source", "menu")
        }.toString()
        deliverToWebview(message)
    }

    private fun deliverToWebview(message: String) {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("ZCodeIDE")
            if (toolWindow == null) {
                queueMessage(message)
                return@invokeLater
            }
            toolWindow.show {
                val current = panel
                if (current != null) current.pushToWebview(message) else queueMessage(message)
            }
        }
    }

    private fun queueMessage(message: String) {
        synchronized(queuedWebviewMessages) { queuedWebviewMessages.addLast(message) }
    }

    internal fun takeQueuedWebviewMessages(): List<String> =
        synchronized(queuedWebviewMessages) {
            val drained = queuedWebviewMessages.toList()
            queuedWebviewMessages.clear()
            drained
        }

    internal fun releasePanel(panel: ZCodePanel) {
        if (this.panel === panel) this.panel = null
    }

    override fun dispose() {
        // server 是应用级共享的，不能随单个项目关闭而停止；它跟随 IDE 生命周期，
        // 由 ZCodeServerManager.dispose() 收尾。这里只断开门面引用。
        panel = null
    }

    companion object {
        fun getInstance(project: Project): ZCodeIdeService = project.service()
    }
}
