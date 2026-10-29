package dev.zcode.ide.service

import dev.zcode.ide.runtime.RuntimeProvisioner
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/**
 * ZCodeServerManager 的 pending 启动侧可测决策（不启动 server、不依赖 ApplicationManager——
 * 只触碰 companion 纯函数与磁盘指针；类加载不触发 platform 服务）。
 */
class ZCodeServerManagerPendingTest {

    @TempDir
    lateinit var root: Path

    // ---- 评审 F1：pending 分支的锁定 Node 来源必须与常规流程同源（baseline manifest） ----

    @Test
    fun `pinned node version comes from baseline manifest and is node 24`() {
        val baseline = RuntimeProvisioner.baselineManifest()
        assertNotNull(baseline, "测试 classpath 应含内置 runtime-manifest.json")

        val pinned = ZCodeServerManager.pinnedNodeVersion()
        assertEquals(baseline!!.nodeVersion, pinned, "pinned 来源必须是 baseline manifest 的 nodeVersion")
        assertTrue(pinned!!.startsWith("24."), "pinned 必须是 24.x（TARGET_MAJOR），实际 $pinned")
    }

    @Test
    fun `pinned node version without baseline is null`() {
        assertNull(ZCodeServerManager.pinnedNodeVersion(null), "baseline 缺失时应交给 NodeProvisioner 自选 24.x")
    }

    // ---- 评审 F3：promote 失败不得执行 cleanup ----

    /** 造一个最小 pending 版本目录（finalize 只关心指针与目录存在性，不校验内部文件）。 */
    private fun installVersionDir(name: String): Path {
        val serverDir = Files.createDirectories(root.resolve(name).resolve("server"))
        Files.writeString(serverDir.resolve("entry-http.js"), "x")
        Files.writeString(
            root.resolve(name).resolve(".complete.json"),
            "{\"version\":\"0.2.0+bbbbbbbbbbbb\",\"sha256\":\"${"a".repeat(64)}\",\"size\":1}",
        )
        return root.resolve(name)
    }

    private fun writePending(path: String) {
        Files.writeString(
            root.resolve("pending.json"),
            "{\"version\":\"0.2.0+bbbbbbbbbbbb\",\"path\":\"$path\",\"sha256\":\"${"a".repeat(64)}\"," +
                "\"installedAt\":\"2026-10-25T00:00:00Z\"}",
        )
    }

    private fun pendingPointer(path: String): RuntimeProvisioner.Pointer =
        RuntimeProvisioner.Pointer(version = "0.2.0+bbbbbbbbbbbb", path = path)

    @Test
    fun `finalize promotes pointer and runs cleanup on success`() {
        installVersionDir("0.2.0-bbbb")
        writePending("0.2.0-bbbb")
        var cleanupArgs: Triple<Boolean, Boolean, Boolean>? = null

        val promoted = ZCodeServerManager.finalizePendingPromotion(root, pendingPointer("0.2.0-bbbb")) { c, p, prev ->
            cleanupArgs = Triple(c, p, prev)
        }

        assertTrue(promoted)
        assertEquals(
            Triple(true, false, true),
            cleanupArgs,
            "cleanup 应以 keepCurrent=true / keepPending=false / keepPreviousOne=true 执行",
        )
        assertFalse(Files.exists(root.resolve("pending.json")), "promote 应删除 pending.json")
        assertEquals("0.2.0+bbbbbbbbbbbb", RuntimeProvisioner.currentVersionAt(root), "current.json ← pending")
    }

    @Test
    fun `finalize skips cleanup when promote fails`() {
        val versionDir = installVersionDir("0.2.0-bbbb")
        writePending("0.2.0-bbbb")
        // current.json 的位置被目录占住 → 写 current 指针必然失败 → promote 返回 false
        Files.createDirectories(root.resolve("current.json"))
        var cleanupInvoked = false

        val promoted = ZCodeServerManager.finalizePendingPromotion(root, pendingPointer("0.2.0-bbbb")) { _, _, _ ->
            cleanupInvoked = true
        }

        assertFalse(promoted)
        assertFalse(cleanupInvoked, "promote 失败不得执行 cleanup——此时 current 仍指旧版，keepPending=false 会删掉正在运行的 pending 版本目录")
        assertTrue(Files.exists(root.resolve("pending.json")), "pending.json 应保留")
        assertTrue(Files.isDirectory(versionDir), "pending 版本目录应保留")
    }
}
