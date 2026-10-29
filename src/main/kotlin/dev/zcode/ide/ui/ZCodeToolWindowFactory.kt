package dev.zcode.ide.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.content.ContentManagerEvent
import com.intellij.ui.content.ContentManagerListener

/**
 * `DumbAware` 不是可选项：平台在 `ToolWindowSetInitializerKt.beanToTask` 里用
 * `DumbService.isDumbAware(factory)` 决定工具的 `canWorkInDumbMode`，为 false 时
 * `ToolWindowImpl.createContentManager` 会用 `DumbService.wrapGently` 把整块内容换成
 * `DumbUnawareHider`，索引期间只显示 "This view is not available until indexes are built"。
 *
 * 我们的面板只做 JCEF + 启动 Node 进程，桥也只用到 VirtualFile / 编辑器和文件对话框，
 * 不依赖 PSI 与索引，因此索引期完全可以正常展示。
 */
class ZCodeToolWindowFactory : ToolWindowFactory, DumbAware {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        addPanelContent(project, toolWindow)

        // 兜底：IDE 的“关闭内容”动作（例如 JCEF 未吞掉的 Ctrl+W）仍可能移除唯一的内容，
        // 之后 ToolWindow 只剩平台自带的空状态。内容被清空时自动补回。
        toolWindow.contentManager.addContentManagerListener(object : ContentManagerListener {
            override fun contentRemoved(event: ContentManagerEvent) {
                val contentManager = toolWindow.contentManager
                if (contentManager.contentCount != 0) return
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed) return@invokeLater
                    if (contentManager.contentCount == 0) addPanelContent(project, toolWindow)
                }
            }
        })
    }

    private fun addPanelContent(project: Project, toolWindow: ToolWindow) {
        val panel = ZCodePanel(project)
        val content = ContentFactory.getInstance().createContent(panel, "ZCode", false)
        content.isCloseable = false
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project): Boolean = true
}
