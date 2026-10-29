package dev.zcode.ide.service

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import dev.zcode.ide.runtime.NodeProvisioner
import dev.zcode.ide.runtime.RuntimeLayout
import dev.zcode.ide.runtime.RuntimeManifest
import dev.zcode.ide.runtime.RuntimeProvisioner
import dev.zcode.ide.runtime.ServerProcess
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 应用级 ZCode server 生命周期：全 IDE 共用一个进程。
 *
 * 官方 server 本身就是多项目的——任务表按 workspaceKey 隔离、agent 按 workspace 各自 spawn，
 * 因此不需要每个 IDE 窗口起一套。各窗口的项目路径由 webview URL 的 `ideWorkspace` 参数携带。
 *
 * 生命周期绑定 IDE 而不是项目窗口：首次打开面板时懒启动，IDE 退出时由 [dispose] 停掉。
 * 关闭全部项目后 server 常驻（欢迎屏重开项目可秒连），与语言服务等常驻进程一致。
 *
 * 启动时序（方案 §6.2/§6.3 启动侧）：server 存活 → pending 优先启动（失败回滚）→
 * [RuntimeProvisioner.ensure]（命中/下载/落地 runtime）→ [NodeProvisioner.ensure] → 起进程。
 */
@Service(Service.Level.APP)
class ZCodeServerManager : Disposable {

    private val log = Logger.getInstance("ZCodeIDE")

    private var server: ServerProcess? = null

    /** server 重启后需要重建页面的面板（每个项目窗口一个）。 */
    private val reloadListeners = CopyOnWriteArrayList<() -> Unit>()

    /**
     * 启动（或复用）共享 server。
     *
     * **必须在后台线程调用**：首次启动可能需要下载 runtime 与 Node 24，或等待其他窗口正在进行的启动；
     * 调用方用 [status] 把进度（下载/解压/启动）回显到面板，并自行切回 EDT。
     */
    @Synchronized
    fun url(status: (String) -> Unit = {}, legacyWorkspace: Path? = null): String {
        val current = server
        if (current != null && current.isAlive()) return current.url()

        // pending 优先：已下载并校验的新版本运行时直接启动；失败回滚到当前版本，继续常规流程。
        startPendingUpdate(status)?.let { return it }

        // 常规流程：resolve 命中（系统属性/env/vendor/插件自带/用户目录）→ 都没有则按 baseline 下载落地。
        val layout = RuntimeProvisioner.ensure(status)

        // 插件自己保证 Node 24：本机没有或版本不对时自动安装，并锁定 runtime 运行所需的 Node 版本。
        val node = NodeProvisioner.ensure(status, pinnedNodeVersion())

        status("正在启动 ZCode server…")
        val started = ServerProcess(layout, node)
        val url = started.start(legacyWorkspace = legacyWorkspace)
        server = started
        return url
    }

    /**
     * 尝试用 pending.json 指向的运行时更新启动 server（方案 §6.3 启动侧）。
     *
     * - 无有效 pending → 返回 null（调用方继续常规流程）；
     * - 启动成功 → promote（current.json ← pending、删 pending.json、cleanup 保留上一版）并返回 URL；
     * - 启动失败 → rollback（删 pending.json，版本目录保留供排查），status 提示后返回 null；
     *   原始异常记入日志，由常规流程接管（常规流程自身的失败会向上抛）。
     */
    private fun startPendingUpdate(status: (String) -> Unit): String? {
        val runtimeRoot = RuntimeProvisioner.defaultRoot()
        val pending = RuntimeProvisioner.validPendingPointer(runtimeRoot) ?: return null
        val pendingDir = runtimeRoot.resolve(pending.path)
        status("正在启动已下载的运行时更新…")
        try {
            val node = NodeProvisioner.ensure(status, pinnedNodeVersion())
            val pendingLayout = RuntimeProvisioner.buildLayout(pendingDir, pending.version)
            val started = ServerProcess(pendingLayout, node)
            val url = started.start()
            if (!finalizePendingPromotion(runtimeRoot, pending)) {
                log.warn(
                    "运行时更新 ${pending.version} 已启动，但 promote（current.json ← pending.json）失败；" +
                        "已跳过目录清理以保留 pending 指针与版本目录",
                )
            }
            server = started
            log.info("Promoted pending runtime update to ${pending.version}")
            return url
        } catch (e: Exception) {
            RuntimeProvisioner.rollbackPendingPointer(runtimeRoot)
            log.warn("运行时更新 ${pending.version} 启动失败，已回滚到当前版本", e)
            status("运行时更新启动失败，已回滚到当前版本")
            return null
        }
    }

    /** 是否可用；和 [url] 一样，可能触发一次本地探测，应在后台线程调用。 */
    fun isAlive(): Boolean = server?.isAlive() == true

    /** 已启动 server 的访问凭据；插件自有进程（远控桥）用它直连本机 server。 */
    fun connection(): ServerConnection? {
        val current = server ?: return null
        if (!current.isAlive()) return null
        return ServerConnection(current.baseUrl(), current.authToken())
    }

    /**
     * 重启：停掉进程并让所有窗口的面板重建页面。
     *
     * **必须在后台线程调用**（[url] 的锁可能被正在启动/下载的线程长时间持有）。
     * 面板重建经 EDT 广播，token 持久化，重启后各窗口 URL 仍然有效。
     */
    @Synchronized
    fun restart() {
        server?.stop()
        server = null
        log.info("ZCode server restarted; reloading ${reloadListeners.size} panel(s)")
        for (listener in reloadListeners) {
            ApplicationManager.getApplication().invokeLater {
                runCatching(listener).onFailure { log.warn("Failed to reload ZCode panel", it) }
            }
        }
    }

    @Synchronized
    fun stop() {
        server?.stop()
        server = null
    }

    fun addReloadListener(listener: () -> Unit) {
        reloadListeners.add(listener)
    }

    fun removeReloadListener(listener: () -> Unit) {
        reloadListeners.remove(listener)
    }

    override fun dispose() {
        stop()
        reloadListeners.clear()
    }

    companion object {
        fun getInstance(): ZCodeServerManager = ApplicationManager.getApplication().service()

        // ---- pending 启动侧的可测决策（纯函数，不依赖 ApplicationManager） ----

        /**
         * 常规与 pending 分支共用的锁定 Node 版本：runtime **运行所需**的 Node（baseline manifest 的
         * nodeVersion，24.x）。不能取版本目录 `BUILD-INFO.toolchain.node`——那是**构建机**的 Node
         * 版本（build-runtime.mjs 写入的 process.version），与运行所需无关，pinned 到它会把 server
         * 跑在旧大版本上（评审 F1）。baseline 缺失返回 null（由 NodeProvisioner 自选最高 24.x）。
         */
        internal fun pinnedNodeVersion(
            baseline: RuntimeManifest? = RuntimeProvisioner.baselineManifest(),
        ): String? = baseline?.nodeVersion

        /**
         * pending 启动成功后的指针收尾（评审 F3）：promote 成功才执行 cleanup
         * （keepCurrent=true 保留现役、keepPending=false 清掉 pending 指针残留语义、
         * keepPreviousOne=true 保留上一版用于回滚）；promote 失败时**不动任何目录**——
         * 此时 current 仍指旧版、pending.json 未删，`keepPending=false` 的 cleanup 会把
         * 正在运行的 pending 版本目录删掉。[cleanup] 可注入（单测观测是否被调用及参数）。
         */
        internal fun finalizePendingPromotion(
            runtimeRoot: Path,
            pending: RuntimeProvisioner.Pointer,
            cleanup: (keepCurrent: Boolean, keepPending: Boolean, keepPreviousOne: Boolean) -> Unit =
                { keepCurrent, keepPending, keepPreviousOne ->
                    RuntimeProvisioner.cleanup(keepCurrent, keepPending, keepPreviousOne)
                },
        ): Boolean {
            if (!RuntimeProvisioner.promotePendingPointer(runtimeRoot, pending)) return false
            cleanup(true, false, true)
            return true
        }
    }
}

data class ServerConnection(val baseUrl: String, val token: String)
