package dev.zcode.ide.runtime

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * 官方 @zcode/server 的进程封装：选端口、生成 token、注入 agent 启动参数、健康检查、杀进程树。
 *
 * 全 IDE 只有一个实例（见 [dev.zcode.ide.service.ZCodeServerManager]）：server 本身按 workspace
 * 处理会话与 agent，项目路径由各窗口 webview 的 `ideWorkspace` 参数传入，进程不绑定任何项目。
 */
class ServerProcess(
    private val layout: RuntimeLayout,
    private val node: NodeRuntime,
) {
    private val log = Logger.getInstance("ZCodeIDE")

    @Volatile
    private var process: Process? = null

    @Volatile
    private var port: Int = -1

    @Volatile
    private var token: String = ""

    /** 复用了上一次 IDE 会话残留的 server（不是本进程的子进程，[stop] 不会也不能杀它）。 */
    @Volatile
    private var reused = false

    fun isAlive(): Boolean {
        process?.let { return it.isAlive }
        return reused && probe()
    }

    /**
     * 启动 server，返回带 token 的 URL。
     *
     * [legacyWorkspace] 只用于一次性端口迁移：老版本按工作区哈希持久化端口，升级到全局端口时
     * 尽量沿用该窗口原来的端口，避免 JCEF localStorage（草稿/最近模型/布局）被重置。
     * 注意只能保住最先启动的那个窗口——各项目的旧端口是不同 origin，无法合并。
     */
    @Synchronized
    fun start(timeoutMs: Long = 60_000, legacyWorkspace: Path? = null): String {
        if (isAlive()) return url()

        val props = PropertiesComponent.getInstance()
        token = loadOrCreateToken(props)
        port = choosePort(props, legacyWorkspace)

        if (!canBind(port)) {
            if (probe()) {
                // 端口上是带同一 token 的 ZCode server：上一次 IDE 会话异常退出留下的。
                // 是否可以直接复用取决于 runtime 版本是否一致（方案 §6.5）：版本不同必须结束残留
                // 进程，否则新版本 runtime 永远无法生效。
                when (val handling = staleServerHandling(
                    props.getValue(RUNTIME_VERSION_KEY),
                    layout.runtimeVersion,
                    hasOwnProcess = process != null,
                ) { findListeningPid(port) }) {
                    StaleServerHandling.Reuse -> {
                        log.warn("Reusing ZCode server left by a previous IDE session: port $port")
                        reused = true
                        persistRuntimeVersion(props, layout.runtimeVersion)
                        return url()
                    }
                    StaleServerHandling.KillOwnProcess -> {
                        log.info("Stopping previous ZCode server (own child) to apply runtime " +
                            "${layout.runtimeVersion ?: "(unknown)"}")
                        process?.let(::killTree)
                        process = null
                        reused = false
                        awaitPortFreeOrSwitch(props)
                    }
                    is StaleServerHandling.KillByPid -> {
                        log.info("Stopping previous ZCode server (pid ${handling.pid}) to apply runtime " +
                            "${layout.runtimeVersion ?: "(unknown)"}")
                        killPidTree(handling.pid)
                        awaitPortFreeOrSwitch(props)
                    }
                    StaleServerHandling.SwitchPort -> switchPortAsLastResort(props)
                }
            } else {
                port = freePort()
                props.setValue(PORT_KEY, port.toString())
                log.warn("ZCode server port was taken by another process, switched to $port")
            }
        }

        val command = listOf(node.path.toString(), layout.serverEntry.toString())
        val builder = ProcessBuilder(command)
            .directory(layout.root.toFile())
            .redirectErrorStream(true)

        val agentArgs = buildJsonArray {
            add(JsonPrimitive(layout.agentEntry.toString()))
            add(JsonPrimitive("app-server"))
            add(JsonPrimitive("--stdio"))
        }.toString()

        builder.environment().apply {
            put("PORT", port.toString())
            put("ZCODE_SERVER_HOST", "127.0.0.1")
            put("ZCODE_SERVER_AUTH_TOKEN", token)
            put("ZCODE_WEB_STATIC_ROOT", layout.webRoot.toString())
            // server 不再绑定项目：这里只给 /api/server-info 一个合理的默认值，
            // 各窗口的实际项目路径由 webview URL 的 ideWorkspace 参数携带。
            put("ZCODE_SERVER_WORKSPACE", System.getProperty("user.home"))
            put("ZCODE_AGENT_SERVER_COMMAND", node.path.toString())
            put("ZCODE_AGENT_SERVER_ARGS_JSON", agentArgs)
        }

        layout.root.resolve("BUILD-INFO.json").takeIf(Files::isRegularFile)?.let { file ->
            runCatching {
                log.info("ZCode runtime build info: ${Files.readString(file).replace(Regex("\\s+"), " ").trim()}")
            }
        }
        log.info("Starting ZCode server: $command port=$port web=${layout.webRoot}")
        reused = false
        val started = builder.start()
        process = started

        Thread({
            runCatching {
                started.inputStream.bufferedReader().forEachLine { line ->
                    log.info("[zcode-server] $line")
                }
            }
        }, "zcode-server-log").apply { isDaemon = true }.start()

        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (!started.isAlive) {
                val code = started.exitValue()
                throw IllegalStateException("ZCode server 提前退出（exit=$code），详见 idea.log")
            }
            if (probe()) {
                persistRuntimeVersion(props, layout.runtimeVersion)
                log.info("ZCode server ready at ${url()}")
                return url()
            }
            Thread.sleep(400)
        }

        stop()
        throw IllegalStateException("ZCode server 启动超时（${timeoutMs / 1000}s）")
    }

    fun url(): String = "http://127.0.0.1:$port/?token=$token"

    fun baseUrl(): String = "http://127.0.0.1:$port"

    /** 供插件自有进程（如远控桥）以 Bearer 方式访问本机 server。 */
    fun authToken(): String = token

    @Synchronized
    fun stop() {
        val current = process
        process = null
        val wasReused = reused
        reused = false
        if (current != null) {
            killTree(current)
        } else if (wasReused) {
            log.info("Leaving the reused ZCode server (port $port) running")
        }
    }

    private fun probe(): Boolean = try {
        val connection = URI("http://127.0.0.1:$port/api/server-info")
            .toURL()
            .openConnection() as HttpURLConnection
        connection.setRequestProperty("Authorization", "Bearer $token")
        connection.connectTimeout = 1500
        connection.readTimeout = 1500
        val code = connection.responseCode
        connection.disconnect()
        code == 200
    } catch (_: Exception) {
        false
    }

    /**
     * 全 IDE 固定一个端口（持久化在应用级 PropertiesComponent）。
     *
     * JCEF 的 localStorage 按 origin（scheme://host:port）隔离，端口一变就是全新的存储：
     * 草稿、最近使用的模型、界面偏好全部丢失。共享 server 后所有窗口同 origin，因此端口
     * 必须在整个 IDE 内保持稳定。
     */
    private fun choosePort(props: PropertiesComponent, legacyWorkspace: Path?): Int {
        props.getValue(PORT_KEY)?.toIntOrNull()?.let { saved ->
            log.info("Reusing ZCode server port $saved (shared across projects)")
            return saved
        }
        migrateLegacyPort(props, legacyWorkspace)?.let { return it }
        val port = freePort()
        props.setValue(PORT_KEY, port.toString())
        return port
    }

    /** 从旧版「按工作区哈希」的端口 key 一次性迁移，尽量保住该窗口的 localStorage。 */
    private fun migrateLegacyPort(props: PropertiesComponent, legacyWorkspace: Path?): Int? {
        val workspace = legacyWorkspace ?: return null
        val legacyKey = LEGACY_PORT_PREFIX + workspacePortKey(workspace)
        val legacy = props.getValue(legacyKey)?.toIntOrNull() ?: return null
        if (!canBind(legacy)) return null
        props.setValue(PORT_KEY, legacy.toString())
        log.info("Migrated ZCode server port $legacy from workspace $workspace")
        return legacy
    }

    private fun loadOrCreateToken(props: PropertiesComponent): String {
        props.getValue(TOKEN_KEY)?.takeIf { it.isNotBlank() }?.let { return it }
        val created = randomToken()
        props.setValue(TOKEN_KEY, created)
        return created
    }

    private fun workspacePortKey(workspace: Path): String =
        MessageDigest.getInstance("SHA-256")
            .digest(workspace.toString().lowercase().toByteArray())
            .take(8)
            .joinToString("") { "%02x".format(it) }

    private fun canBind(candidate: Int): Boolean = try {
        ServerSocket(candidate).use { true }
    } catch (_: Exception) {
        false
    }

    private fun freePort(): Int = ServerSocket(0).use { it.localPort }

    private fun randomToken(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private fun killTree(target: Process) {
        try {
            if (System.getProperty("os.name").lowercase().contains("win")) {
                ProcessBuilder("taskkill", "/PID", target.pid().toString(), "/T", "/F")
                    .redirectErrorStream(true)
                    .start()
                    .waitFor(5, TimeUnit.SECONDS)
            } else {
                target.descendants().forEach { it.destroy() }
                target.destroy()
                if (!target.waitFor(5, TimeUnit.SECONDS)) target.destroyForcibly()
            }
        } catch (e: Exception) {
            log.warn("Failed to stop ZCode server", e)
        }
    }

    // ---- 残留 server 的处理（方案 §6.5 的运行时部分） ----

    /** 按端口找监听进程 PID：Windows 用 netstat，Unix 用 lsof；找不到返回 null。 */
    private fun findListeningPid(port: Int): Int? = try {
        if (isWindows()) {
            parseNetstatPid(execAndRead("netstat", "-ano", "-p", "tcp"), port)
        } else {
            parseLsofPid(execAndRead("lsof", "-ti", "tcp:$port"))
        }
    } catch (e: Exception) {
        log.warn("Failed to find the process listening on port $port", e)
        null
    }

    private fun execAndRead(vararg command: String): String {
        val process = ProcessBuilder(*command).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        process.waitFor(5, TimeUnit.SECONDS)
        return output
    }

    /** 结束按端口找到的残留 server：Windows taskkill 进程树，Unix kill -9。 */
    private fun killPidTree(pid: Int) {
        try {
            if (isWindows()) {
                ProcessBuilder("taskkill", "/PID", pid.toString(), "/T", "/F")
                    .redirectErrorStream(true)
                    .start()
                    .waitFor(5, TimeUnit.SECONDS)
            } else {
                ProcessBuilder("kill", "-9", pid.toString())
                    .redirectErrorStream(true)
                    .start()
                    .waitFor(5, TimeUnit.SECONDS)
            }
        } catch (e: Exception) {
            log.warn("Failed to stop stale ZCode server (pid $pid)", e)
        }
    }

    /** 杀掉残留 server 后等端口释放；超时未释放则换新端口（最后手段）。 */
    private fun awaitPortFreeOrSwitch(props: PropertiesComponent) {
        val deadline = System.currentTimeMillis() + PORT_FREE_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if (canBind(port)) return
            Thread.sleep(200)
        }
        if (canBind(port)) return
        switchPortAsLastResort(props)
    }

    /** 换新空闲端口并持久化：localStorage 会随 origin 变化全部重置，只作为杀不掉残留进程时的最后手段。 */
    private fun switchPortAsLastResort(props: PropertiesComponent) {
        val fresh = freePort()
        props.setValue(PORT_KEY, fresh.toString())
        log.warn(
            "无法结束旧版本 ZCode server（端口 $port 被残留进程占用），已改用新端口 $fresh 启动新版本运行时；" +
                "端口变化会使 JCEF localStorage（草稿、最近使用的模型、界面偏好）重置，此为最后手段。",
        )
        port = fresh
    }

    private fun persistRuntimeVersion(props: PropertiesComponent, version: String?) {
        if (version == null) props.unsetValue(RUNTIME_VERSION_KEY)
        else props.setValue(RUNTIME_VERSION_KEY, version)
    }

    private fun isWindows(): Boolean =
        System.getProperty("os.name").lowercase().contains("win")

    companion object {
        private const val PORT_KEY = "zcode.ide.server.port"
        private const val TOKEN_KEY = "zcode.ide.server.token"
        private const val LEGACY_PORT_PREFIX = "zcode.ide.port."

        /** 本次启动的 server 所用 runtime 版本（方案 §6.5 的复用判定依据）。 */
        private const val RUNTIME_VERSION_KEY = "zcode.ide.server.runtimeVersion"

        /** 杀掉残留 server 后等待端口释放的上限。 */
        private const val PORT_FREE_TIMEOUT_MS = 10_000L

        private val WHITESPACE = Regex("\\s+")

        // ---- 残留 server 的 runtime 版本处理（方案 §6.5；纯逻辑 internal 供单测） ----

        /** 持久化的 runtime 版本与本次要启动的是否一致；任一方未知（null，含双方均 null）视为不一致。 */
        internal fun isSameRuntimeVersion(persisted: String?, current: String?): Boolean =
            persisted != null && current != null && persisted == current

        /**
         * 残留 server（端口被占、token 相同、probe 通过）的处理决策：
         * 版本一致 → 复用；不同 → 优先杀本会话子进程，其次按端口找 PID 结束，最后换端口。
         * [pidByPort] 延迟执行——版本一致或杀子进程足够时，不做 netstat/lsof 查询。
         */
        internal fun staleServerHandling(
            persistedVersion: String?,
            currentVersion: String?,
            hasOwnProcess: Boolean,
            pidByPort: () -> Int?,
        ): StaleServerHandling = when {
            isSameRuntimeVersion(persistedVersion, currentVersion) -> StaleServerHandling.Reuse
            hasOwnProcess -> StaleServerHandling.KillOwnProcess
            else -> pidByPort()?.let(StaleServerHandling::KillByPid) ?: StaleServerHandling.SwitchPort
        }

        /** Windows `netstat -ano -p tcp` 输出解析：本地地址端口为 [port] 且 LISTENING 的行 → PID（首个命中）。 */
        internal fun parseNetstatPid(output: String, port: Int): Int? =
            output.lineSequence()
                .map(String::trim)
                .map { it.split(WHITESPACE) }
                .firstOrNull { columns ->
                    columns.size >= 5 &&
                        columns[0].equals("TCP", ignoreCase = true) &&
                        columns[1].endsWith(":$port") &&
                        columns[3].equals("LISTENING", ignoreCase = true)
                }
                ?.get(4)
                ?.toIntOrNull()

        /** Unix `lsof -ti tcp:<port>` 输出解析（每行一个 PID）→ 首个可解析的 PID。 */
        internal fun parseLsofPid(output: String): Int? =
            output.lineSequence().map(String::trim).mapNotNull(String::toIntOrNull).firstOrNull()
    }

    /** 残留 server 处理决策（[staleServerHandling] 的返回值）。 */
    internal sealed interface StaleServerHandling {
        /** 版本一致：直接复用。 */
        data object Reuse : StaleServerHandling

        /** 旧进程是本次 IDE 会话的子进程：killTree。 */
        data object KillOwnProcess : StaleServerHandling

        /** 非本会话子进程，但按端口找到了监听 PID：结束它。 */
        data class KillByPid(val pid: Int) : StaleServerHandling

        /** 找不到 PID：放弃原端口，换新空闲端口启动（localStorage 会重置）。 */
        data object SwitchPort : StaleServerHandling
    }
}
