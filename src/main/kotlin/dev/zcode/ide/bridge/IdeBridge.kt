package dev.zcode.ide.bridge

import com.intellij.ide.BrowserUtil
import com.intellij.ide.actions.RevealFileAction
import com.intellij.ide.projectView.ProjectView
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileWrapper
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import dev.zcode.ide.remote.RemoteControlBridge
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.time.LocalDate
import java.util.Base64
import java.util.UUID
import javax.swing.SwingUtilities

/** 与桌面端 `desktopSaveFile.ts` 对齐：单文件落盘上限 50 MiB。 */
private const val MAX_SAVE_FILE_BYTES = 50L * 1024 * 1024

/** 与 `workflowArtifactFile.ts` 的 `WORKFLOW_ARTIFACT_FILE_MAX_BYTES` 对齐。 */
private const val MAX_ARTIFACT_BYTES = 20 * 1024 * 1024

data class BridgeResult(
    val id: Int,
    val ok: Boolean,
    val payload: JsonElement?,
    val error: String?,
) {
    companion object {
        fun success(id: Int, payload: JsonElement?) = BridgeResult(id, true, payload, null)
        fun failure(id: Int, error: String) = BridgeResult(id, false, null, error)
    }
}

/**
 * Web UI → IDE 的能力桥。请求形状 `{id, method, params}`，返回结果由面板回填到
 * `window.__zcodeIdeResolve(id, ok, payload)`。
 */
class IdeBridge(private val project: Project) {

    fun handle(requestJson: String): BridgeResult {
        val request = runCatching { Json.parseToJsonElement(requestJson).jsonObject }.getOrNull()
            ?: return BridgeResult.failure(0, "invalid request json")
        val id = request["id"]?.jsonPrimitive?.intOrNull
            ?: return BridgeResult.failure(0, "missing request id")
        val method = request["method"]?.jsonPrimitive?.content
            ?: return BridgeResult.failure(id, "missing method")
        val params = request["params"]?.takeIf { it !is JsonNull }

        return try {
            BridgeResult.success(id, dispatch(method, params))
        } catch (t: Throwable) {
            BridgeResult.failure(id, t.message ?: t.toString())
        }
    }

    private fun dispatch(method: String, params: JsonElement?): JsonElement = when (method) {
        "selectDirectory" -> optionalPath(chooseDirectory())
        "selectDirectories" -> JsonArray(chooseDirectories().map(::JsonPrimitive))
        "selectFile" -> optionalPath(chooseFile())
        "selectFiles" -> JsonArray(chooseFiles().map(::JsonPrimitive))
        "saveFile" -> saveFile(params)
        "createTempTextAttachment" -> createTempTextAttachment(params)
        "materializeWorkflowArtifactFile" -> materializeWorkflowArtifactFile(params)
        "openExternal" -> {
            BrowserUtil.browse(requiredString(params, "url"))
            JsonNull
        }
        "openInFileManager" -> jsonSuccess(reveal(requiredString(params, "path")))
        "openExternalFile" -> jsonSuccess(
            openInEditor(
                requiredString(params, "path"),
                optionalInt(params, "line"),
                optionalInt(params, "column"),
            ),
        )
        "selectInProjectView" -> jsonSuccess(selectInProjectView(requiredString(params, "path")))
        "showTaskNotification" -> {
            notify(params)
            JsonNull
        }
        // ---- Web 远控（复用官方弹窗，只补 device 桥）----
        "startWebRemoteControl" -> {
            // 项目收集与自动恢复共用同一套逻辑，避免两处规则漂移。
            val result = RemoteControlBridge.getInstance().startFromIde(
                optionalString(params, "workspacePath") ?: project.basePath,
                optionalString(params, "workspaceIdentity"),
            )
            buildJsonObject {
                put("status", "running")
                put("sessionId", result.deviceSid)
                put("windowControlSessionId", result.deviceSid)
                put("qrUrl", result.qrUrl)
                put("connectUrl", result.qrUrl)
                put("workspacePath", result.workspacePath)
                result.workspaceIdentity?.let { put("workspaceIdentity", it) }
            }
        }
        "stopWebRemoteControl" -> {
            // 用户显式停止：清除启用意图，下次 IDE 启动不再自动恢复。
            RemoteControlBridge.getInstance().stop(clearIntent = true)
            JsonNull
        }
        "getWebRemoteControlStatus" -> RemoteControlBridge.getInstance().status()
        // 未知方法必须显式失败：静默返回 null 会让「前端声明了、Kotlin 忘了实现」的
        // 能力在界面上表现为毫无反应（2026-10-24 的桥签名问题就是这么藏住的）。
        else -> throw IllegalArgumentException("unsupported bridge method: $method")
    }

    private fun optionalPath(path: String?): JsonElement =
        path?.let(::JsonPrimitive) ?: JsonNull

    private fun chooseDirectory(): String? = onEdt {
        FileChooser.chooseFile(
            FileChooserDescriptorFactory.createSingleFolderDescriptor(),
            project,
            null,
        )?.path
    }

    private fun chooseDirectories(): List<String> = onEdt {
        FileChooser.chooseFiles(
            FileChooserDescriptorFactory.createMultipleFoldersDescriptor(),
            project,
            null,
        ).map { it.path }
    }

    private fun chooseFile(): String? = onEdt {
        FileChooser.chooseFile(
            FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor(),
            project,
            null,
        )?.path
    }

    private fun chooseFiles(): List<String> = onEdt {
        FileChooser.chooseFiles(
            FileChooserDescriptorFactory.createMultipleFilesNoJarsDescriptor(),
            project,
            null,
        ).map { it.path }
    }

    /**
     * 另存为：前端已把字节转成 base64（`ArrayBuffer` 经 JSON 会变成 `{}`）。
     * 对话框只在 EDT 上弹，落盘回到桥的线程执行，避免大文件写盘阻塞 UI。
     */
    private fun saveFile(params: JsonElement?): JsonElement {
        val suggestedName = optionalString(params, "suggestedName")
            ?.trim()
            ?.let { File(it).name.take(120) }
            ?.takeIf { it.isNotEmpty() }
            ?: return errorResult("invalid_file_payload")
        val bytes = optionalString(params, "dataBase64")
            ?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() }
            ?: return errorResult("invalid_file_payload")
        if (bytes.isEmpty()) return errorResult("invalid_file_payload")
        if (bytes.size > MAX_SAVE_FILE_BYTES) return errorResult("file_too_large")

        val wrapper: VirtualFileWrapper = onEdt<VirtualFileWrapper?> {
            val descriptor = FileSaverDescriptor("保存文件", "选择保存位置")
            FileChooserFactory.getInstance()
                .createSaveFileDialog(descriptor, project)
                .save(null as VirtualFile?, suggestedName)
        } ?: return buildJsonObject {
            put("success", false)
            put("canceled", true)
        }

        return try {
            val target = wrapper.file
            target.writeBytes(bytes)
            buildJsonObject {
                put("success", true)
                put("path", target.absolutePath)
            }
        } catch (t: Throwable) {
            errorResult("write_failed")
        }
    }

    /** 长文本粘贴落盘：落点与桌面端一致（`~/.zcode/tmp/paste-attachments/<yyyy-MM-dd>/`）。 */
    private fun createTempTextAttachment(params: JsonElement?): JsonElement {
        val text = requiredString(params, "text")
        require(text.isNotEmpty()) { "Temporary text attachment content is empty" }
        val filename = tempTextFilename(optionalString(params, "filename"))
        val dir = zcodeDataRoot()
            .resolve("tmp")
            .resolve("paste-attachments")
            .resolve(LocalDate.now().toString())
        Files.createDirectories(dir)
        val target = dir.resolve(filename)
        val bytes = text.toByteArray(Charsets.UTF_8)
        Files.write(target, bytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
        return buildJsonObject {
            put("filename", filename)
            put("localPath", target.toString())
            put("mimeType", "text/plain")
            put("sizeBytes", bytes.size)
        }
    }

    /**
     * 工作流产物落成本机副本。路径规则与桌面端 `workflowArtifactFile.ts` 一致：
     * `~/.zcode/tmp/workflow-artifacts/<runId>-<digest>/<artifactId>-<digest>/v<N>/<name>`。
     * 一版字节不变，已有副本不覆盖（用户可能已在外部编辑过）。
     */
    private fun materializeWorkflowArtifactFile(params: JsonElement?): JsonElement {
        val runId = requiredString(params, "runId")
        val artifactId = requiredString(params, "artifactId")
        val version = requiredInt(params, "version")
        require(version >= 1) { "version must be >= 1" }
        val fileName = requiredString(params, "fileName")
        val bytes = Base64.getDecoder().decode(requiredString(params, "bytesBase64"))
        require(bytes.isNotEmpty()) { "artifact bytes are empty" }
        require(bytes.size <= MAX_ARTIFACT_BYTES) {
            "workflow artifact is too large (${bytes.size} bytes, cap $MAX_ARTIFACT_BYTES)"
        }

        val dir = zcodeDataRoot()
            .resolve("tmp")
            .resolve("workflow-artifacts")
            .resolve(identitySegment(runId))
            .resolve(identitySegment(artifactId))
            .resolve("v$version")
        Files.createDirectories(dir)
        val target = dir.resolve(sanitizeFileName(fileName, artifactId))
        if (!Files.exists(target)) {
            val temporary = dir.resolve(".${UUID.randomUUID()}.partial")
            Files.write(temporary, bytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)
            try {
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE)
            } catch (_: FileAlreadyExistsException) {
                // 并发点击：另一个请求已经落下同一份字节，保留它。
            } catch (_: AtomicMoveNotSupportedException) {
                // 少数文件系统不支持原子移动；普通 move 同样不会覆盖已存在目标。
                try {
                    Files.move(temporary, target)
                } catch (_: FileAlreadyExistsException) {
                    // 同上。
                }
            } finally {
                Files.deleteIfExists(temporary)
            }
        }
        return buildJsonObject { put("localPath", target.toString()) }
    }

    private fun reveal(path: String): Boolean {
        val file = File(path)
        if (!file.exists()) return false
        RevealFileAction.openFile(file)
        return true
    }

    private fun openInEditor(path: String, line: Int? = null, column: Int? = null): Boolean =
        onEdt {
            val virtualFile = findVirtualFile(path)
            if (virtualFile == null) {
                NotificationGroupManager.getInstance()
                    .getNotificationGroup("ZCodeIDE")
                    .createNotification("ZCode", "未能打开文件：$path", NotificationType.WARNING)
                    .notify(project)
                return@onEdt false
            }
            if (line != null && line > 0) {
                // IDE 的 logicalLine / logicalColumn 从 0 开始；消息链接里的行号从 1 开始。
                OpenFileDescriptor(
                    project,
                    virtualFile,
                    line - 1,
                    (column ?: 1).coerceAtLeast(1) - 1,
                ).navigate(true)
            } else {
                FileEditorManager.getInstance(project).openFile(virtualFile, true)
            }
            true
        }

    private fun selectInProjectView(path: String): Boolean = onEdt {
        val virtualFile = findVirtualFile(path)
        if (virtualFile == null) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("ZCodeIDE")
                .createNotification("ZCode", "未能在项目视图中定位：$path", NotificationType.WARNING)
                .notify(project)
            return@onEdt false
        }
        ProjectView.getInstance(project).select(null, virtualFile, true)
        true
    }

    /** 前端可能送来带 `./` 或 `..` 段的路径；先规范化再查 VFS。 */
    private fun findVirtualFile(path: String): VirtualFile? {
        val canonical = runCatching { File(path).canonicalFile }.getOrDefault(File(path))
        return LocalFileSystem.getInstance()
            .refreshAndFindFileByPath(canonical.absolutePath.replace('\\', '/'))
    }

    private fun zcodeDataRoot(): Path {
        val dataBaseDir = System.getenv("ZCODE_DATA_BASE_DIR")?.trim()?.takeIf { it.isNotEmpty() }
            ?: System.getProperty("user.home")
        return Paths.get(dataBaseDir, ".zcode")
    }

    private fun tempTextFilename(raw: String?): String {
        val base = raw?.trim()?.takeIf { it.isNotEmpty() } ?: "pasted-text.txt"
        var name = base.replace("\u0000", "-").replace(Regex("[\\\\/:]"), "-")
        if (!name.endsWith(".txt")) name = "$name.txt"
        val suffix = UUID.randomUUID().toString().take(8)
        val dot = name.lastIndexOf('.')
        return if (dot <= 0) "$name-$suffix.txt" else "${name.substring(0, dot)}-$suffix${name.substring(dot)}"
    }

    /** 与桌面端一致：清洗后的 id + 原始 id 的摘要，避免大小写/前导点撞目录。 */
    private fun identitySegment(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
            .take(8)
        return "${sanitizeSegment(value)}-$digest"
    }

    private fun sanitizeSegment(value: String): String {
        val cleaned = value
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .replace(Regex("^\\.+"), "")
            .take(120)
        return cleaned.ifEmpty { "_" }
    }

    private fun sanitizeFileName(fileName: String, artifactId: String): String {
        val leaf = fileName.split(Regex("[\\\\/]")).last()
        var cleaned = leaf
            .replace(Regex("[<>:\"|?*\\u0000-\\u001f]"), "_")
            .trim()
            .replace(Regex("^\\.+"), "")
            .replace(Regex("[. ]+$"), "")
        if (cleaned.isEmpty()) cleaned = sanitizeSegment(artifactId)
        if (Regex("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?$", RegexOption.IGNORE_CASE).matches(cleaned)) {
            cleaned = "_$cleaned"
        }
        if (cleaned.length > 120) {
            val dot = cleaned.lastIndexOf('.')
            val extension = if (dot > 0 && cleaned.length - dot <= 16) cleaned.substring(dot) else ""
            cleaned = cleaned.take(120 - extension.length) + extension
        }
        return cleaned
    }

    private fun errorResult(code: String): JsonElement = buildJsonObject {
        put("success", false)
        put("error", code)
    }

    private fun jsonSuccess(success: Boolean): JsonElement = buildJsonObject {
        put("success", success)
    }

    private fun notify(params: JsonElement?) {
        val title = optionalString(params, "title") ?: "ZCode"
        val body = optionalString(params, "body").orEmpty()
        NotificationGroupManager.getInstance()
            .getNotificationGroup("ZCodeIDE")
            .createNotification(title, body, NotificationType.INFORMATION)
            .notify(project)
    }

    private fun requiredString(params: JsonElement?, key: String): String =
        optionalString(params, key) ?: error("missing $key")

    private fun optionalString(params: JsonElement?, key: String): String? =
        (params as? JsonObject)?.get(key)?.jsonPrimitive?.content

    private fun optionalInt(params: JsonElement?, key: String): Int? =
        (params as? JsonObject)?.get(key)?.jsonPrimitive?.intOrNull

    private fun requiredInt(params: JsonElement?, key: String): Int =
        optionalInt(params, key) ?: error("missing or invalid $key")

    private fun <T> onEdt(block: () -> T): T {
        // 桥处理器可能已经在 EDT 上；此时 invokeAndWait 会直接抛异常。
        if (SwingUtilities.isEventDispatchThread()) return block()
        var result: T? = null
        var failure: Throwable? = null
        ApplicationManager.getApplication().invokeAndWait {
            try {
                result = block()
            } catch (t: Throwable) {
                failure = t
            }
        }
        failure?.let { throw it }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }
}
