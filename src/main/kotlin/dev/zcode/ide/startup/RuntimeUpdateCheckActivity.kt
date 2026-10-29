package dev.zcode.ide.startup

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity
import com.intellij.util.concurrency.AppExecutorUtil
import dev.zcode.ide.runtime.RuntimeUpdater
import java.util.concurrent.TimeUnit

/**
 * IDE 启动后延迟 60 秒做一次运行时更新检查（方案 §6.3）。
 *
 * 延迟是为了不与项目恢复/索引抢资源；检查本身在 pooled thread 执行（[RuntimeUpdater.checkInBackground]
 * 的约定是不在 EDT）。自动更新开关、24h 节流与并发重入防御都在 RuntimeUpdater 内
 * （关闭时直接返回 DISABLED，这里不重复判断），因此多个项目窗口各触发一次也幂等。
 *
 * 启动活动不许炸：调度失败与检查异常都吞掉并 logger.warn。
 *
 * 标记 `DumbAware`：只做 60s 后的网络检查，不读索引；不标记会被平台压到索引结束之后。
 */
class RuntimeUpdateCheckActivity : StartupActivity, StartupActivity.DumbAware {

    override fun runActivity(project: Project) {
        val application = ApplicationManager.getApplication() ?: return
        if (application.isUnitTestMode) return
        try {
            AppExecutorUtil.getAppScheduledExecutorService().schedule({
                application.executeOnPooledThread {
                    runCatching { RuntimeUpdater.checkInBackground() }
                        .onFailure { LOG.warn("ZCode runtime update check failed", it) }
                }
            }, DELAY_SECONDS, TimeUnit.SECONDS)
        } catch (t: Throwable) {
            LOG.warn("Failed to schedule ZCode runtime update check", t)
        }
    }

    private companion object {
        private const val DELAY_SECONDS = 60L
        private val LOG = Logger.getInstance("ZCodeIDE")
    }
}
