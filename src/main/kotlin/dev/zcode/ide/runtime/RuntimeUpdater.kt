package dev.zcode.ide.runtime

import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.Notification
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import dev.zcode.ide.service.ZCodeServerManager
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 一次运行时更新检查的结果。
 *
 * @param outcome 检查结论（方案 §6.3：UP_TO_DATE/THROTTLED/INCOMPATIBLE/DOWNLOADED/FAILED/DISABLED）。
 * @param runtimeVersion 已取得远端清单时的远端版本；未取得（DISABLED/THROTTLED/FAILED/验签失败）为 null。
 * @param message 面向诊断/设置页的补充说明（FAILED 时必含原因）；无补充时为 null。
 */
data class CheckResult(
    val outcome: Outcome,
    val runtimeVersion: String?,
    val message: String?,
)

/** 更新检查结论枚举。 */
enum class Outcome { UP_TO_DATE, THROTTLED, INCOMPATIBLE, DOWNLOADED, FAILED, DISABLED }

/** 远端清单单次 HTTP 拉取结果；[Err] 携带原因，供 FAILED 文案。 */
internal sealed class FetchResult {
    class Ok(val bytes: ByteArray) : FetchResult()
    class Err(val reason: String) : FetchResult()
}

/**
 * ZCode 运行时更新检查器（方案 §6.3 检查侧）：
 *
 * 后台拉远端签名 manifest → Ed25519 验签（失败回退内置 baseline）→ 判兼容/判新 →
 * 下载新版本目录落地 `.complete.json`（**不写 current.json**）→ 写 pending.json → 发通知。
 * promote（current.json ← pending.json）由启动逻辑（[ZCodeServerManager]）做，本类不参与。
 *
 * 触发接线（plugin.xml/StartupActivity/ZCodePanel）不在本类（后续任务）；调用约定与
 * [NodeProvisioner.ensure] 一致：**[checkInBackground] 必须在调用方的后台线程执行，方法内不切线程**。
 *
 * 可覆盖项（均为 internal，供单测注入；生产代码不写）：
 * [httpFetch]（网络拉取）、[store]（持久化键值）、[publicKeyProvider]（验签公钥）、
 * [runtimeRoot]（用户 runtime 目录）、[notifyFn]（通知），以及
 * [RuntimeProvisioner.downloadImpl]（runtime zip 下载）。
 *
 * 可配置项优先级（方案 §6.7）：env/系统属性 > 设置页（[RuntimeSettings] 的持久化键）> 默认。
 * 调试用环境变量/系统属性（设置页在它们之下）：
 * - `ZCODE_IDE_RUNTIME_AUTO_UPDATE=0`：禁用自动更新（不再发任何请求）；
 * - `ZCODE_IDE_RUNTIME_MANIFEST_URL`：覆盖 manifest 地址（含 channel 段的完整 URL）；
 * - `ZCODE_IDE_RUNTIME_CHANNEL`：渠道名（默认 stable），拼进默认 URL 路径。
 */
object RuntimeUpdater {
    // 单元测试环境没有 IntelliJ platform 运行时，Logger 初始化可能失败；lazy + runCatching 兜底。
    private val log: Logger? by lazy { runCatching { Logger.getInstance("ZCodeIDE") }.getOrNull() }

    private const val NOTIFICATION_GROUP = "ZCodeIDE"
    private const val AUTO_UPDATE_DISABLED = RuntimeSettings.ENV_AUTO_UPDATE
    private const val MANIFEST_URL_OVERRIDE = RuntimeSettings.ENV_MANIFEST_URL
    private const val CHANNEL = RuntimeSettings.ENV_CHANNEL
    private const val DEFAULT_CHANNEL = "stable"

    /** 占位域名：正式 CDN 就绪后由构建重出（与 baseline manifest 的占位一致）。 */
    private const val DEFAULT_MANIFEST_URL = "https://cdn.example.com/zcode-ide/runtime/$DEFAULT_CHANNEL/manifest.json"

    /** 持久化键：上次检查时间（epochMillis，检查开始时即写入，失败也计，避免失败风暴）。 */
    private const val KEY_LAST_CHECK = "zcode.ide.runtime.lastUpdateCheck"

    /** 持久化键：验签失败已提示过（最多提示一次，之后静默）。 */
    private const val KEY_SIG_FAIL_NOTIFIED = "zcode.ide.runtime.sigFailNotified"

    /** 节流窗口：24 小时。 */
    private const val THROTTLE_INTERVAL_MS = 24L * 60 * 60 * 1000

    private const val PUBLIC_KEY_RESOURCE = "runtime-signing-public.pem"
    private const val COMPLETE_FILE = ".complete.json"

    private const val CONNECT_TIMEOUT_SECONDS = 20L
    private const val REQUEST_TIMEOUT_SECONDS = 15L

    private val checking = AtomicBoolean(false)

    private val http: HttpClient = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NORMAL)
        .connectTimeout(Duration.ofSeconds(CONNECT_TIMEOUT_SECONDS))
        .build()

    /** 内置公钥（classpath `runtime-signing-public.pem`），读取结果缓存；缺失返回 null（按验签失败处理）。 */
    private val bundledPublicKeyPem: ByteArray? by lazy {
        runCatching {
            RuntimeUpdater::class.java.classLoader
                .getResourceAsStream(PUBLIC_KEY_RESOURCE)
                ?.use { it.readBytes() }
        }.getOrNull()
    }

    // ---- 可注入点（internal，供单测；生产代码不写） ----

    /** 持久化键值（默认 PropertiesComponent；单测环境无 platform 运行时，注入内存实现）。 */
    internal interface PersistentStore {
        fun readLong(key: String): Long?
        fun writeLong(key: String, value: Long)
        fun readFlag(key: String): Boolean
        fun writeFlag(key: String, value: Boolean)
    }

    private object PropertiesComponentStore : PersistentStore {
        // getInstance() 依赖 Application；单测环境抛错时静默退化为 no-op。
        private fun props(): PropertiesComponent? = runCatching { PropertiesComponent.getInstance() }.getOrNull()

        // PropertiesComponent 没有 Long setter：epochMillis 以字符串形式存取。
        override fun readLong(key: String): Long? = props()
            ?.getValue(key)?.trim()?.takeIf(String::isNotBlank)?.toLongOrNull()

        override fun writeLong(key: String, value: Long) {
            props()?.setValue(key, value.toString())
        }

        override fun readFlag(key: String): Boolean = props()?.getBoolean(key, false) ?: false

        override fun writeFlag(key: String, value: Boolean) {
            props()?.setValue(key, value)
        }
    }

    @Volatile
    internal var store: PersistentStore = PropertiesComponentStore

    /** 清单/签名的 HTTP 拉取（默认网络实现 [fetchRemote]；单测注入假响应，不起真网络）。 */
    @Volatile
    internal var httpFetch: (String) -> FetchResult = ::fetchRemote

    /** 验签公钥来源（默认内置 `runtime-signing-public.pem`；单测注入测试密钥对的公钥）。 */
    @Volatile
    internal var publicKeyProvider: () -> ByteArray? = { bundledPublicKeyPem }

    /** 用户 runtime 根（默认 [RuntimeProvisioner.defaultRoot]；单测指向临时目录，不碰真实用户目录）。 */
    @Volatile
    internal var runtimeRoot: () -> Path = { RuntimeProvisioner.defaultRoot() }

    /**
     * 通知出口：仅在 [Outcome.DOWNLOADED] / [Outcome.FAILED] 时被 [checkInBackground] 调用；
     * 默认实现见 [notifyResult]（可注入替换，单测用 spy 观察是否触发）。
     */
    @Volatile
    internal var notifyFn: (result: CheckResult, retryStatus: (String) -> Unit) -> Unit =
        { result, retryStatus -> notifyResult(result, retryStatus) }

    // ---- 公开 API（冻结契约） ----

    /**
     * 执行一次更新检查，返回结果；**不抛异常**（后台检查，失败折叠为 [Outcome.FAILED]）。
     * **必须在调用方的后台线程执行**（与 [NodeProvisioner.ensure] 同约定），方法内不切线程。
     *
     * 流程：开关 → 并发防御 → 24h 节流（检查开始即写时间戳，失败也计）→ 拉远端（https）
     * → 验签（失败回退内置 baseline，最多提示一次）→ 判兼容/判新 → 下载落地（不写 current）
     * → 写 pending.json → 通知（仅 DOWNLOADED/FAILED）。
     *
     * [forceCheck] = true 跳过节流（「重试」动作与手动检查入口用）；并发重入直接返回 [Outcome.THROTTLED]。
     * [status] 用于把下载/解压进度回显到面板（调用方负责切回 EDT）。
     */
    fun checkInBackground(status: (String) -> Unit = {}, forceCheck: Boolean = false): CheckResult {
        // 1. 开关：显式禁用时不做任何网络请求，也不占用并发名额与节流时间戳。
        val disabledReason = autoUpdateDisabledReason()
        if (disabledReason != null) {
            return CheckResult(Outcome.DISABLED, null, "运行时自动更新已禁用（$disabledReason）")
        }
        // 9. 并发防御：同进程同时只允许一个检查在跑。
        if (!checking.compareAndSet(false, true)) {
            return CheckResult(Outcome.THROTTLED, null, "已有一次运行时更新检查在进行中")
        }
        val result: CheckResult = try {
            // 2. 节流：检查开始时即写入本次时间戳（失败也计，避免失败风暴）。
            val now = System.currentTimeMillis()
            val last = store.readLong(KEY_LAST_CHECK)
            if (!forceCheck && last != null && now - last < THROTTLE_INTERVAL_MS) {
                CheckResult(Outcome.THROTTLED, null, "距上次检查不足 24 小时，已跳过")
            } else {
                store.writeLong(KEY_LAST_CHECK, now)
                try {
                    runCheck(status)
                } catch (e: Exception) {
                    // 兜底：任何未预期异常都折叠为 FAILED，不让后台检查向调用方抛异常。
                    log?.warn("运行时更新检查出现未预期异常", e)
                    CheckResult(Outcome.FAILED, null, "运行时更新检查异常：${e.message ?: e::class.java.simpleName}")
                }
            }
        } finally {
            checking.set(false)
        }
        // 8. 通知：仅 DOWNLOADED / FAILED 发通知；INCOMPATIBLE/THROTTLED/UP_TO_DATE/DISABLED 静默。
        if (result.outcome == Outcome.DOWNLOADED || result.outcome == Outcome.FAILED) {
            notifyFn(result, status)
        }
        return result
    }

    // ---- 检查流程（开关/并发/节流已在 [checkInBackground] 处理） ----

    private fun runCheck(status: (String) -> Unit): CheckResult {
        // 3. 拉远端 manifest.json + manifest.sig（任一失败 → FAILED，不抛异常）。
        val manifestUrl = manifestUrl()
        val manifestBytes = when (val fetched = httpFetch(manifestUrl)) {
            is FetchResult.Ok -> fetched.bytes
            is FetchResult.Err -> return CheckResult(Outcome.FAILED, null, "拉取运行时清单失败：${fetched.reason}")
        }
        val sigBytes = when (val fetched = httpFetch("$manifestUrl.sig")) {
            is FetchResult.Ok -> fetched.bytes
            is FetchResult.Err -> return CheckResult(Outcome.FAILED, null, "拉取清单签名失败：${fetched.reason}")
        }
        val manifest = RuntimeManifest.parse(manifestBytes)
            ?: return CheckResult(Outcome.FAILED, null, "运行时清单解析失败：$manifestUrl")

        // 4. 验签：失败 → 忽略远端、回退内置 baseline（方案 §4.3），最多提示一次。
        val publicKey = publicKeyProvider()
        if (publicKey == null || !RuntimeManifest.verifySignature(manifestBytes, sigBytes.decodeToString(), publicKey)) {
            warnSignatureFailureOnce(manifestUrl)
            return CheckResult(Outcome.UP_TO_DATE, null, "远端清单签名校验失败，已忽略并沿用当前运行时")
        }

        // 5. 兼容与判新：current 为 null 时视为 0.0.0，任何有效远端都算新。
        if (!manifest.isCompatible(RuntimeManifest.PLUGIN_VERSION)) {
            return CheckResult(
                Outcome.INCOMPATIBLE,
                manifest.runtimeVersion,
                "远端运行时 ${manifest.runtimeVersion} 与当前插件 ${RuntimeManifest.PLUGIN_VERSION} 不兼容",
            )
        }
        val current = RuntimeProvisioner.currentVersionAt(runtimeRoot()) ?: "0.0.0"
        if (!manifest.isNewerThan(versionBaseManifest(current))) {
            return CheckResult(Outcome.UP_TO_DATE, manifest.runtimeVersion, null)
        }

        // 6. 下载落地（不写 current.json；磁盘/锁/校验失败按 RuntimeProvisioner 既有语义 → FAILED）。
        val versionDir = try {
            RuntimeProvisioner.installVersion(manifest, status, root = runtimeRoot())
        } catch (e: Exception) {
            return CheckResult(
                Outcome.FAILED,
                manifest.runtimeVersion,
                "下载运行时 ${manifest.runtimeVersion} 失败：${e.message ?: e::class.java.simpleName}",
            )
        }
        // 锁等待循环可能在「另一进程装了别的 current」时提前返回：落地完整性在此兜底校验。
        if (!Files.isRegularFile(versionDir.resolve(COMPLETE_FILE))) {
            return CheckResult(Outcome.FAILED, manifest.runtimeVersion, "运行时 ${manifest.runtimeVersion} 下载后目录不完整：$versionDir")
        }

        // 7. 写 pending.json（promote 由启动逻辑做）。
        try {
            RuntimeProvisioner.writePendingPointer(
                runtimeRoot(),
                RuntimeProvisioner.Pointer(
                    version = manifest.runtimeVersion,
                    path = manifest.versionDir,
                    sha256 = manifest.sha256,
                    installedAt = Instant.now().toString(),
                ),
            )
        } catch (e: Exception) {
            return CheckResult(
                Outcome.FAILED,
                manifest.runtimeVersion,
                "写入运行时更新指针（pending.json）失败：${e.message ?: e::class.java.simpleName}",
            )
        }

        log?.info("Downloaded ZCode runtime update ${manifest.runtimeVersion} at $versionDir")
        return CheckResult(
            Outcome.DOWNLOADED,
            manifest.runtimeVersion,
            "运行时更新 ${manifest.runtimeVersion} 已下载，重启 ZCode 后生效",
        )
    }

    // ---- 配置解析 ----

    /**
     * 自动更新开关（方案 §6.7：env/系统属性 > 设置页 > 默认开）：
     * - env/系统属性 `ZCODE_IDE_RUNTIME_AUTO_UPDATE` 显式配置时以其为准（`=0` 禁用，其余值显式开启、
     *   同时压过设置页的关闭）；
     * - 否则读设置页 [RuntimeSettings.KEY_AUTO_UPDATE]（"false" 禁用，与 `=0` 等效）；
     * - 都没有 → 默认开。返回禁用原因（供 DISABLED 文案），null = 未禁用。internal 供覆盖链单测。
     */
    internal fun autoUpdateDisabledReason(): String? {
        System.getProperty(AUTO_UPDATE_DISABLED)?.trim()?.takeIf(String::isNotBlank)?.let { raw ->
            return if (raw == "0") "系统属性 $AUTO_UPDATE_DISABLED=0" else null
        }
        System.getenv(AUTO_UPDATE_DISABLED)?.trim()?.takeIf(String::isNotBlank)?.let { raw ->
            return if (raw == "0") "环境变量 $AUTO_UPDATE_DISABLED=0" else null
        }
        if (RuntimeSettings.storedValue(RuntimeSettings.KEY_AUTO_UPDATE)?.equals("false", ignoreCase = true) == true) {
            return "设置页已关闭自动检查运行时更新"
        }
        return null
    }

    /**
     * manifest 地址（方案 §6.7：env/系统属性 > 设置页 > 默认）：
     * env/系统属性 `ZCODE_IDE_RUNTIME_MANIFEST_URL` 优先（完整 URL）；其次设置页
     * [RuntimeSettings.KEY_MANIFEST_URL]；都没有 → 默认 `<占位域名>/zcode-ide/runtime/<channel>/manifest.json`，
     * channel 取 `ZCODE_IDE_RUNTIME_CHANNEL`/设置页 [RuntimeSettings.KEY_CHANNEL]（默认 stable）。
     * HTTPS 强制在 [fetchRemote] 统一把关。internal 供覆盖链单测。
     */
    internal fun manifestUrl(): String {
        val override = RuntimeSettings.settingValue(
            MANIFEST_URL_OVERRIDE,
            MANIFEST_URL_OVERRIDE,
            RuntimeSettings.KEY_MANIFEST_URL,
        )
        if (override != null) return override
        val channel = RuntimeSettings.settingValue(CHANNEL, CHANNEL, RuntimeSettings.KEY_CHANNEL) ?: DEFAULT_CHANNEL
        return "https://cdn.example.com/zcode-ide/runtime/$channel/manifest.json"
    }

    /**
     * 默认网络拉取：只允许 https（方案 §8.3），http 仅显式调试开关（ZCODE_IDE_RUNTIME_ALLOW_HTTP）放行；
     * 连接 20s / 请求 15s 超时；非 200 或任何异常折叠为 [FetchResult.Err]（后台检查不抛异常）。
     */
    internal fun fetchRemote(url: String): FetchResult {
        if (!RuntimeSettings.isAllowedSourceUrl(url)) {
            return FetchResult.Err("非 HTTPS 地址已拒绝（本地联调可设 ZCODE_IDE_RUNTIME_ALLOW_HTTP=1）：$url")
        }
        if (!url.startsWith("https://")) RuntimeSettings.warnInsecureOnce(url)
        return try {
            val request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(REQUEST_TIMEOUT_SECONDS))
                .GET()
                .build()
            val response = http.send(request, HttpResponse.BodyHandlers.ofByteArray())
            if (response.statusCode() == 200) {
                FetchResult.Ok(response.body())
            } else {
                FetchResult.Err("HTTP ${response.statusCode()}：$url")
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            FetchResult.Err("请求被中断：$url")
        } catch (e: Exception) {
            FetchResult.Err("网络错误：${e.message ?: e::class.java.simpleName}（$url）")
        }
    }

    /** 验签失败提示：logger.warn（含「签名校验失败」）最多一次，之后静默（行为不变，仍回退 baseline）。 */
    private fun warnSignatureFailureOnce(manifestUrl: String) {
        if (store.readFlag(KEY_SIG_FAIL_NOTIFIED)) return
        store.writeFlag(KEY_SIG_FAIL_NOTIFIED, true)
        log?.warn("ZCode 运行时清单签名校验失败，已忽略远端清单并回退内置基线：$manifestUrl")
    }

    /**
     * 用本地 current.json 的 version 构造判新基准（只参与 [RuntimeManifest.isNewerThan] 的
     * 数字三元组比较，其余字段无意义）。version 无法解析时由 isNewerThan 判 false（不更新）。
     */
    private fun versionBaseManifest(version: String): RuntimeManifest = RuntimeManifest(
        schemaVersion = RuntimeManifest.SCHEMA_VERSION,
        channel = "",
        runtimeVersion = version,
        runtimeApiVersion = RuntimeManifest.RUNTIME_API_VERSION,
        minPluginVersion = "0.0.0",
        maxPluginVersion = "*.*.*",
        nodeVersion = "",
        archivePath = "",
        sha256 = "0".repeat(64),
        size = 1,
        uncompressedSize = 0,
        builtAt = "",
        forkCommit = "",
    )

    // ---- 通知 ----

    /**
     * 通知实现（[Notifications.Bus]，组 id `ZCodeIDE`）。单测环境没有 platform 运行时：
     * `ApplicationManager.getApplication()` 为 null 时直接跳过，不炸。
     *
     * - DOWNLOADED：「重启 ZCode」→ 后台线程 [ZCodeServerManager.restart]（restart 的实现契约是
     *   必须在后台线程调用——url 的锁可能被下载线程长时间持有；通知 action 回调在 EDT，需切走）；
     * - FAILED：「重试」→ 后台线程重跑一次强制检查。
     */
    internal fun notifyResult(result: CheckResult, retryStatus: (String) -> Unit) {
        val application = ApplicationManager.getApplication() ?: return
        when (result.outcome) {
            Outcome.DOWNLOADED -> {
                val notification = Notification(
                    NOTIFICATION_GROUP,
                    "ZCode 运行时更新",
                    "ZCode 运行时更新已下载，重启 ZCode 后生效",
                    NotificationType.INFORMATION,
                )
                notification.addAction(object : AnAction("重启 ZCode") {
                    override fun actionPerformed(event: AnActionEvent) {
                        application.executeOnPooledThread {
                            runCatching { ZCodeServerManager.getInstance().restart() }
                                .onFailure { log?.warn("Failed to restart ZCode server for runtime update", it) }
                        }
                    }
                })
                Notifications.Bus.notify(notification)
            }

            Outcome.FAILED -> {
                val notification = Notification(
                    NOTIFICATION_GROUP,
                    "ZCode 运行时更新",
                    "ZCode 运行时更新检查失败",
                    NotificationType.WARNING,
                )
                notification.addAction(object : AnAction("重试") {
                    override fun actionPerformed(event: AnActionEvent) {
                        application.executeOnPooledThread {
                            runCatching { checkInBackground(retryStatus, forceCheck = true) }
                                .onFailure { log?.warn("Runtime update retry failed", it) }
                        }
                    }
                })
                Notifications.Bus.notify(notification)
            }

            else -> Unit
        }
    }
}
