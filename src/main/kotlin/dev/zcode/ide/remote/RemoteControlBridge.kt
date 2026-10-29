package dev.zcode.ide.remote

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.ProjectManager
import dev.zcode.ide.runtime.NodeProvisioner
import dev.zcode.ide.runtime.RuntimeLayout
import dev.zcode.ide.service.ZCodeServerManager
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * 应用级 Web 远控 device 桥。
 *
 * 桥进程复用官方 desktop 的 Relay V2 transport，把手机 `/remote/v4` 的 RPC 帧转发到本机共享
 * server 的 `/ws`。插件侧只多一个进程和三个桥方法，官方远控弹窗/二维码/手机页面都不改。
 */
@Service(Service.Level.APP)
class RemoteControlBridge : Disposable {

    private val log = Logger.getInstance("ZCodeIDE")

    private var process: Process? = null
    private var deviceSid: String? = null
    private var qrUrl: String? = null
    private var workspacePath: String? = null
    private var workspaceIdentity: String? = null
    /** 当前桥登记的项目列表签名；列表不变就复用同一个桥进程（多窗口共用）。 */
    private var workspaceSignature: String? = null
    private var lastError: String? = null

    data class StartResult(
        val deviceSid: String,
        val qrUrl: String,
        val workspacePath: String,
        val workspaceIdentity: String?,
    )

    /**
     * 启动（或复用）远控桥。
     *
     * **必须在后台线程调用**：[NodeProvisioner.ensure] 可能下载 Node，桥本身还要完成账号注册
     * 和 relay 握手。
     *
     * 远控桥是应用级单进程：`workspaces` 是全 IDE 打开的项目列表，`primaryWorkspace` 只是手机
     * 首次进入时的默认选中项。项目列表不变时，任何窗口再次调用都复用同一个桥；列表变化
     * （打开/关闭项目）才重启一次以刷新手机端的 workspace 列表。
     */
    @Synchronized
    fun start(
        workspaces: List<String>,
        primaryWorkspace: String,
        workspaceIdentity: String?,
    ): StartResult {
        val signature = workspaces.distinct().sorted().joinToString("\u0000")
        val current = process
        val sid = deviceSid
        val url = qrUrl
        if (
            current != null && current.isAlive &&
            workspaceSignature == signature && sid != null && url != null
        ) {
            saveEnabledIntent(this.workspacePath ?: primaryWorkspace, this.workspaceIdentity)
            return StartResult(sid, url, this.workspacePath ?: primaryWorkspace, this.workspaceIdentity)
        }
        stop()
        return try {
            val result = startLocked(workspaces.distinct(), primaryWorkspace, workspaceIdentity, signature)
            saveEnabledIntent(result.workspacePath, result.workspaceIdentity)
            result
        } catch (t: Throwable) {
            lastError = t.message ?: t.toString()
            stop()
            throw t
        }
    }

    /**
     * 从 IDE 现状启动：自动收集所有打开的项目，`primaryWorkspace` 作为默认选中项。
     * 手动开启与 IDE 启动后的自动恢复都走这里，避免两套项目收集逻辑。
     */
    fun startFromIde(primaryWorkspace: String?, workspaceIdentity: String?): StartResult {
        val openProjects = collectOpenProjectPaths()
        val primary = primaryWorkspace?.let(::normalizeIdeWorkspacePath) ?: openProjects.firstOrNull()
        if (primary == null) throw IllegalStateException("没有可用的项目目录")
        val workspaces = if (primary !in openProjects) openProjects + primary else openProjects
        return start(workspaces, primary, workspaceIdentity)
    }

    /** 自动恢复用：是否有存活的桥进程。 */
    fun isRunning(): Boolean = process?.isAlive == true

    /** 上次成功开启远控的目标（workspacePath + 可选 identity）。 */
    fun readEnabledIntent(): Pair<String, String?>? {
        val raw = PropertiesComponent.getInstance().getValue(ENABLED_INTENT_KEY)?.trim()
        if (raw.isNullOrEmpty()) return null
        return runCatching {
            val payload = Json.parseToJsonElement(raw).jsonObject
            val path = payload["workspacePath"]?.jsonPrimitive?.content?.trim()
            if (path.isNullOrEmpty()) {
                null
            } else {
                path to payload["workspaceIdentity"]?.jsonPrimitive?.content?.trim()
            }
        }.getOrNull()
    }

    private fun saveEnabledIntent(workspacePath: String, workspaceIdentity: String?) {
        runCatching {
            val payload = buildJsonObject {
                put("workspacePath", workspacePath)
                workspaceIdentity?.takeIf { it.isNotBlank() }?.let { put("workspaceIdentity", it) }
            }
            PropertiesComponent.getInstance().setValue(ENABLED_INTENT_KEY, payload.toString())
        }.onFailure { log.warn("Failed to persist remote control intent", it) }
    }

    private fun collectOpenProjectPaths(): List<String> =
        ProjectManager.getInstance().openProjects
            .asSequence()
            .filter { !it.isDisposed }
            .mapNotNull { it.basePath }
            .map(::normalizeIdeWorkspacePath)
            .filter(String::isNotBlank)
            .distinct()
            .toList()

    private fun normalizeIdeWorkspacePath(path: String): String =
        path.replace('\\', '/').trimEnd('/')

    private fun startLocked(
        workspaces: List<String>,
        primaryWorkspace: String,
        workspaceIdentity: String?,
        signature: String,
    ): StartResult {
        val connection = ZCodeServerManager.getInstance().connection()
            ?: throw IllegalStateException("ZCode server 未运行，请先打开 ZCode 工具窗口")
        val layout = RuntimeLayout.resolve()
            ?: throw IllegalStateException("未找到 ZCode 运行时")
        val entry = layout.remoteBridgeEntry
            ?: throw IllegalStateException(
                "当前 runtime 未包含远控桥，请重新运行 node scripts/build-runtime.mjs",
            )
        // ensure 加了 pinnedVersion 默认参数后，空 status 回调不能再走尾 lambda（会绑到 String? 参数上）。
        val node = NodeProvisioner.ensure()
        // 插件使用独立设备身份，手机端会同时看到 `<host>`（桌面）与 `<host> (IDE)`，
        // 两端可以同时在线，不会互相踢下线。
        val deviceMid = loadOrCreateDeviceMid()
        val command = buildList {
            add(node.path.toString())
            add(entry.toString())
            add("--server-url=${connection.baseUrl}")
            add("--server-token=${connection.token}")
            workspaces.forEach { add("--workspace=$it") }
            add("--primary-workspace=$primaryWorkspace")
            workspaceIdentity?.takeIf { it.isNotBlank() }?.let { add("--workspace-identity=$it") }
            add("--device-mid=$deviceMid")
        }
        log.info(
            "Starting ZCode remote bridge: server=${connection.baseUrl} " +
                "primary=$primaryWorkspace workspaces=${workspaces.size}",
        )
        val started = ProcessBuilder(command).redirectErrorStream(false).start()
        process = started
        this.workspacePath = primaryWorkspace
        this.workspaceIdentity = workspaceIdentity
        this.workspaceSignature = signature

        Thread({
            runCatching {
                started.errorStream.bufferedReader().forEachLine {
                    log.info("[zcode-remote] $it")
                }
            }
        }, "zcode-remote-bridge-log").apply { isDaemon = true }.start()

        val line = readReadyLine(started, 30_000)
        val payload = Json.parseToJsonElement(line).jsonObject
        val sid = payload["deviceSid"]?.jsonPrimitive?.content
            ?: throw IllegalStateException("远控桥未返回 deviceSid")
        val url = payload["qrUrl"]?.jsonPrimitive?.content
            ?: throw IllegalStateException("远控桥未返回 qrUrl")
        deviceSid = sid
        qrUrl = url
        lastError = null
        log.info("ZCode remote bridge ready: device=$sid")
        return StartResult(sid, url, primaryWorkspace, workspaceIdentity)
    }

    private fun readReadyLine(started: Process, timeoutMs: Long): String {
        val future = CompletableFuture<String>()
        Thread({
            try {
                val reader = started.inputStream.bufferedReader()
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.contains("\"type\":\"ready\"")) {
                        future.complete(line)
                        return@Thread
                    }
                    if (line.contains("\"type\":\"error\"")) {
                        val message = runCatching {
                            Json.parseToJsonElement(line).jsonObject["message"]
                                ?.jsonPrimitive?.content
                        }.getOrNull()
                        future.completeExceptionally(
                            IllegalStateException(message ?: "远控桥启动失败"),
                        )
                        return@Thread
                    }
                }
                future.completeExceptionally(IllegalStateException("远控桥进程已退出，未返回 ready"))
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }, "zcode-remote-bridge-ready").apply { isDaemon = true }.start()
        return try {
            future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (t: Exception) {
            // 去掉 ExecutionException 包装，UI 直接显示桥给出的原因。
            val cause = (t as? java.util.concurrent.ExecutionException)?.cause ?: t
            throw IllegalStateException(cause.message ?: "远控桥启动失败", cause)
        }
    }

    /**
     * 停止桥进程。
     *
     * [clearIntent] 只由用户显式“停止远控”传 true：清除上次开启的目标，下次 IDE 启动不再自动恢复。
     * IDE 退出、切换 workspace、启动失败等内部停止都保留启用意图。
     */
    @Synchronized
    fun stop(clearIntent: Boolean = false) {
        if (clearIntent) {
            PropertiesComponent.getInstance().unsetValue(ENABLED_INTENT_KEY)
        }
        val current = process
        process = null
        deviceSid = null
        qrUrl = null
        workspacePath = null
        workspaceIdentity = null
        workspaceSignature = null
        if (current == null) return
        runCatching {
            current.descendants().forEach { it.destroy() }
            current.destroy()
            if (!current.waitFor(3, TimeUnit.SECONDS)) {
                current.descendants().forEach { it.destroyForcibly() }
                current.destroyForcibly()
            }
        }.onFailure { log.warn("Failed to stop ZCode remote bridge", it) }
    }

    /** 返回官方远控弹窗需要的状态形状；未知字段保持缺省。与 start/stop 共用 this 锁，保证读写一致。 */
    @Synchronized
    fun status(): JsonObject {
        val alive = process?.isAlive == true
        return buildJsonObject {
            put("status", if (alive) "running" else "idle")
            deviceSid?.let {
                put("sessionId", it)
                put("windowControlSessionId", it)
            }
            qrUrl?.let {
                put("qrUrl", it)
                put("connectUrl", it)
            }
            workspacePath?.let { put("workspacePath", it) }
            workspaceIdentity?.let { put("workspaceIdentity", it) }
            lastError?.let { put("error", it) }
        }
    }

    private fun loadOrCreateDeviceMid(): String {
        val props = PropertiesComponent.getInstance()
        props.getValue(DEVICE_MID_KEY)?.takeIf { it.isNotBlank() }?.let { return it }
        val created = "ide-${UUID.randomUUID()}"
        props.setValue(DEVICE_MID_KEY, created)
        return created
    }

    override fun dispose() {
        // IDE 退出不清除启用意图，下次启动继续自动恢复。
        stop(clearIntent = false)
    }

    companion object {
        private const val DEVICE_MID_KEY = "zcode.ide.remote.deviceMid"
        private const val ENABLED_INTENT_KEY = "zcode.ide.remote.lastEnabled"

        fun getInstance(): RemoteControlBridge =
            ApplicationManager.getApplication().service()
    }
}
