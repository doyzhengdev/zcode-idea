package dev.zcode.ide.startup

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.Constraints
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.util.Alarm
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 把 ZCode 的两个编辑器右键动作提到 EditorPopupMenu 最前面。
 *
 * 只靠 plugin.xml 的 `anchor="first"` 不够：其他插件（CodeBuddy、翻译）也用 first，
 * 最终位置由注册顺序决定。这里在启动完成后把动作从组里摘掉再以 FIRST 插回。
 *
 * 注意：VSIX 桥接类插件可能在项目打开后才动态插入菜单项，所以除了立即提升，
 * 再延迟提升一次；仍然只是尽力而为，无法阻止之后又有插件插到更前面。
 *
 * 标记 `DumbAware`：只操作 ActionManager，不读索引；不标记会被平台压到索引结束后才执行，
 * 索引久的工程上右键菜单顺序会长时间不对。
 */
class PromoteZCodeActionsActivity : ProjectActivity, DumbAware {

    override suspend fun execute(project: Project) {
        if (!promoted.compareAndSet(false, true)) return
        val application = ApplicationManager.getApplication()
        application.invokeLater { runCatching { promote() }.onFailure(::logFailure) }

        // 参数 project 作为 parent disposable，项目关闭时自动取消。
        Alarm(Alarm.ThreadToUse.SWING_THREAD, project)
            .addRequest({ runCatching { promote() }.onFailure(::logFailure) }, 3000)
    }

    private fun logFailure(error: Throwable) {
        LOG.warn("Failed to promote ZCode editor popup actions", error)
    }

    private fun promote() {
        val actionManager = ActionManager.getInstance()
        val group = actionManager.getAction("EditorPopupMenu") as? DefaultActionGroup ?: return
        val selection = actionManager.getAction("ZCodeIDE.SendSelectionToComposer") ?: return
        val files = actionManager.getAction("ZCodeIDE.SendToComposer") ?: return

        // 先摘掉再插回：后插入的排在更前，所以先插选区、再插文件，最终「添加到对话」在上。
        group.remove(selection)
        group.remove(files)
        group.add(selection, Constraints.FIRST)
        group.add(files, Constraints.FIRST)
    }

    private companion object {
        val promoted = AtomicBoolean(false)
        val LOG: Logger = Logger.getInstance("ZCodeIDE")
    }
}
