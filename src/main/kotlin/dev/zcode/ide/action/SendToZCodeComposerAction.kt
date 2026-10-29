package dev.zcode.ide.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.vfs.VirtualFile
import dev.zcode.ide.service.ZCodeIdeService

/**
 * 项目树 / 编辑器 Tab / 编辑器右键：把选中的文件或目录引用添加到 ZCode 对话。
 *
 * 注册方式参考 zcode-jetbrains-plugin 的 SendFileToInputAction；文案写在构造器里
 * （2026.1 对 XML 的 %key% 会解析成占位符原文，不走 bundle）。
 * 只发送路径引用，不读文件内容；页面把它作为文件 mention 插进输入框。
 */
class SendToZCodeComposerAction : AnAction(
    "添加到 ZCode 对话",
    "把选中的文件或目录路径作为引用添加到 ZCode 对话",
    IconLoader.getIcon("/icons/zcode.png", SendToZCodeComposerAction::class.java),
) {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = resolveFiles(e).isNotEmpty()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val files = resolveFiles(e)
        if (files.isEmpty()) return
        ZCodeIdeService.getInstance(project)
            .sendPathsToComposer(files.map { it.path to it.isDirectory })
    }

    /** 个别菜单语境只供给单数 VIRTUAL_FILE、无数组；补单数兜底，避免入口被隐藏。 */
    private fun resolveFiles(e: AnActionEvent): List<VirtualFile> =
        e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList()
            ?: e.getData(CommonDataKeys.VIRTUAL_FILE)?.let { listOf(it) }
            ?: emptyList()
}
