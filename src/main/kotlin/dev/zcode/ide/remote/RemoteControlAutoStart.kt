package dev.zcode.ide.remote

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity
import dev.zcode.ide.service.ZCodeServerManager
import java.util.concurrent.atomic.AtomicBoolean

/**
 * IDE 启动后延迟恢复上次开启的 Web 远控。
 *
 * 与桌面客户端的 `webRemoteControlLastEnabledContext` 语义一致：
 * - 上次成功开启过远控 → 本次启动自动拉起（先确保共享 server 就绪，再启动桥）；
 * - 用户显式点“停止远控” → 清除意图，下次不再自动恢复；
 * - IDE 退出 / 正常关闭窗口不清除意图。
 *
 * 延迟 + 重试是为了等 IDE 恢复项目、ZCode server 懒启动完成；全部在后台线程执行。
 */
@Service(Service.Level.APP)
class RemoteControlAutoStart : Disposable {

    private val log = Logger.getInstance("ZCodeIDE")

    /** 防止初始循环与索引结束补试并发拉起两份桥进程。 */
    private val restoring = AtomicBoolean(false)

    /** 两轮恢复之间的最小间隔（毫秒），见 [attemptRestore]。 */
    @Volatile
    private var lastAttemptAtMillis = 0L

    init {
        val application = ApplicationManager.getApplication()
        if (!application.isUnitTestMode) {
            application.executeOnPooledThread {
                Thread.sleep(INITIAL_DELAY_MS)
                restore()
            }
        }
    }

    private fun restore() {
        val intent = RemoteControlBridge.getInstance().readEnabledIntent() ?: return
        attemptRestore(intent)
    }

    /**
     * 索引结束时的补试入口（由 [RemoteControlStartupActivity] 订阅 `DUMB_MODE` 触发）。
     *
     * 启动期的初始重试窗口（8s + 6×10s）经常整个落在 dumb mode 内：索引抢占 CPU、
     * runtime 还没就绪、依赖缺失都会让 server 起不来。旧实现此时直接放弃，导致这次
     * IDE 会话的远控再也不会恢复。索引结束再试一次，且失败后下一次索引结束时还会再试。
     */
    fun retryAfterIndexing() {
        val bridge = RemoteControlBridge.getInstance()
        if (bridge.isRunning()) return
        val intent = bridge.readEnabledIntent() ?: return
        attemptRestore(intent)
    }

    private fun attemptRestore(intent: Pair<String, String?>) {
        val now = System.currentTimeMillis()
        // 初始循环与索引结束补试可能前后脚到达；间隔太近就不再开一轮，避免重复拉起进程。
        if (now - lastAttemptAtMillis < MIN_INTERVAL_BETWEEN_RESTORES_MS) return
        if (!restoring.compareAndSet(false, true)) return
        lastAttemptAtMillis = now
        try {
            val bridge = RemoteControlBridge.getInstance()
            repeat(MAX_ATTEMPTS) { attempt ->
                if (bridge.isRunning()) return
                if (ensureServerReady()) {
                    try {
                        val result = bridge.startFromIde(intent.first, intent.second)
                        log.info(
                            "Auto-restored ZCode remote bridge: device=${result.deviceSid} " +
                                "workspace=${result.workspacePath}",
                        )
                        return
                    } catch (t: Throwable) {
                        log.warn(
                            "Auto-restore ZCode remote bridge failed " +
                                "(attempt ${attempt + 1}/$MAX_ATTEMPTS): ${t.message}",
                        )
                    }
                }
                Thread.sleep(RETRY_INTERVAL_MS)
            }
            log.info(
                "Auto-restore ZCode remote bridge gave up after $MAX_ATTEMPTS attempts; " +
                    "will retry when indexing completes",
            )
        } finally {
            restoring.set(false)
        }
    }

    private fun ensureServerReady(): Boolean {
        val manager = ZCodeServerManager.getInstance()
        if (manager.connection() != null) return true
        return runCatching {
            // 用户可能还没打开 ZCode 面板；自动恢复需要主动拉起共享 server。
            manager.url(status = { })
            manager.connection() != null
        }.getOrElse { error ->
            log.warn("Failed to start ZCode server for remote bridge restore: ${error.message}")
            false
        }
    }

    override fun dispose() {}

    companion object {
        private const val INITIAL_DELAY_MS = 8_000L
        private const val RETRY_INTERVAL_MS = 10_000L
        private const val MAX_ATTEMPTS = 6
        private const val MIN_INTERVAL_BETWEEN_RESTORES_MS = 30_000L

        fun getInstance(): RemoteControlAutoStart =
            ApplicationManager.getApplication().service()
    }
}

/**
 * 启动活动只负责确保应用级自动恢复服务被实例化；每个项目窗口调用一次无副作用。
 *
 * 标记 `DumbAware`：服务本身延迟 8s 在后台线程跑，不读索引；不标记的话平台会把它压到
 * smart mode 之后才执行，索引久的工程上远控恢复会被推迟很久。
 *
 * 同时订阅 `DUMB_MODE`：启动期恢复常常整段落在索引里而失败（初始重试窗口只有 6 次），
 * 索引结束再补试一次，避免一次失败就让本次 IDE 会话的远控永久失效。
 */
class RemoteControlStartupActivity : StartupActivity, StartupActivity.DumbAware {

    override fun runActivity(project: Project) {
        RemoteControlAutoStart.getInstance()
        project.messageBus.connect(project).subscribe(
            DumbService.DUMB_MODE,
            object : DumbService.DumbModeListener {
                override fun exitDumbMode() {
                    ApplicationManager.getApplication().executeOnPooledThread {
                        runCatching { RemoteControlAutoStart.getInstance().retryAfterIndexing() }
                            .onFailure { log.warn("Retry ZCode remote bridge after indexing failed", it) }
                    }
                }
            },
        )
    }

    private companion object {
        private val log = Logger.getInstance("ZCodeIDE")
    }
}
