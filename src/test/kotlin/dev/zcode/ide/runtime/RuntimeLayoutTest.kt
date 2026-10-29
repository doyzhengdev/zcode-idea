package dev.zcode.ide.runtime

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class RuntimeLayoutTest {

    @TempDir
    lateinit var root: Path

    /** 最小打包布局：只要 server/entry-http.js 存在即命中 staged 分支。 */
    private fun stagedRuntime(dir: Path): Path {
        Files.createDirectories(dir.resolve("server"))
        Files.writeString(dir.resolve("server").resolve("entry-http.js"), "export {}")
        return dir
    }

    /** 用户目录候选：current.json + 完整版本目录（.complete.json + 两个入口文件）。 */
    private fun installUserRuntime(
        runtimeRoot: Path,
        version: String,
        versionDir: String = version.replace('+', '-'),
    ) {
        val dir = Files.createDirectories(runtimeRoot.resolve(versionDir).resolve("server"))
        Files.writeString(dir.resolve("entry-http.js"), "export {}")
        Files.createDirectories(runtimeRoot.resolve(versionDir).resolve("web"))
        Files.writeString(runtimeRoot.resolve(versionDir).resolve("web").resolve("index.html"), "<html>")
        Files.writeString(runtimeRoot.resolve(versionDir).resolve(".complete.json"), "{\"version\":\"$version\"}")
        Files.writeString(
            runtimeRoot.resolve("current.json"),
            "{\"version\":\"$version\",\"path\":\"$versionDir\",\"sha256\":\"${"a".repeat(64)}\"," +
                "\"installedAt\":\"2026-10-25T00:00:00Z\"}",
        )
    }

    private fun writeBuildInfo(dir: Path, pluginVersion: String = "0.1.0", commit: String? = "cf345dcb7d0af835951076bcd6192efeba6ecfa3") {
        val commitJson = commit?.let { "\"$it\"" } ?: "null"
        Files.writeString(
            dir.resolve("BUILD-INFO.json"),
            "{\"pluginVersion\":\"$pluginVersion\",\"builtAt\":\"2026-10-25T00:00:00Z\"," +
                "\"fork\":{\"repo\":\"x\",\"branch\":\"y\",\"commit\":$commitJson,\"dirty\":false}," +
                "\"toolchain\":{\"node\":\"v24.14.0\"},\"locked\":true}",
        )
    }

    // ---- 候选顺序 ----

    @Test
    fun `first candidate root wins`() {
        val first = stagedRuntime(Files.createDirectories(root.resolve("first")))
        val second = stagedRuntime(Files.createDirectories(root.resolve("second")))

        val layout = RuntimeLayout.resolveFrom(listOf(first, second), null)

        assertNotNull(layout)
        assertEquals(first, layout!!.root)
    }

    @Test
    fun `invalid candidates fall through to later ones`() {
        val broken = Files.createDirectories(root.resolve("broken")) // 目录存在但没有入口文件
        val good = stagedRuntime(Files.createDirectories(root.resolve("good")))

        val layout = RuntimeLayout.resolveFrom(listOf(broken, good), null)

        assertNotNull(layout)
        assertEquals(good, layout!!.root)
    }

    @Test
    fun `user dir candidate is lower priority than candidate roots`() {
        val candidate = stagedRuntime(Files.createDirectories(root.resolve("bundled")))
        val userRoot = root.resolve("user-runtime")
        installUserRuntime(userRoot, "0.2.0+aaaaaaaaaaaa")

        val layout = RuntimeLayout.resolveFrom(listOf(candidate), userRoot)

        assertNotNull(layout)
        assertEquals(candidate, layout!!.root, "候选根命中时不应走用户目录候选")
    }

    @Test
    fun `user dir candidate is used when no candidate root matches`() {
        val userRoot = root.resolve("user-runtime")
        installUserRuntime(userRoot, "0.2.0+aaaaaaaaaaaa")

        val layout = RuntimeLayout.resolveFrom(emptyList(), userRoot)

        assertNotNull(layout)
        assertEquals(userRoot.resolve("0.2.0-aaaaaaaaaaaa"), layout!!.root)
        assertEquals("0.2.0+aaaaaaaaaaaa", layout.runtimeVersion, "用户目录候选的 runtimeVersion 来自 current.json")
    }

    // ---- 用户目录候选的无效情形：一律跳过，不抛错 ----

    @Test
    fun `corrupt current json skips user dir candidate`() {
        val userRoot = root.resolve("user-runtime")
        Files.createDirectories(userRoot)
        Files.writeString(userRoot.resolve("current.json"), "{ broken json")

        assertNull(RuntimeLayout.resolveFrom(emptyList(), userRoot))
    }

    @Test
    fun `missing current json skips user dir candidate`() {
        assertNull(RuntimeLayout.resolveFrom(emptyList(), root.resolve("nope")))
    }

    @Test
    fun `missing version dir skips user dir candidate`() {
        val userRoot = root.resolve("user-runtime")
        Files.createDirectories(userRoot)
        Files.writeString(
            userRoot.resolve("current.json"),
            "{\"version\":\"0.2.0+aaaaaaaaaaaa\",\"path\":\"0.2.0-aaaaaaaaaaaa\"}",
        )

        assertNull(RuntimeLayout.resolveFrom(emptyList(), userRoot))
    }

    @Test
    fun `version dir without complete marker skips user dir candidate`() {
        val userRoot = root.resolve("user-runtime")
        val dir = Files.createDirectories(userRoot.resolve("0.2.0-aaaaaaaaaaaa").resolve("server"))
        Files.writeString(dir.resolve("entry-http.js"), "export {}")
        Files.createDirectories(userRoot.resolve("0.2.0-aaaaaaaaaaaa").resolve("web"))
        Files.writeString(userRoot.resolve("0.2.0-aaaaaaaaaaaa").resolve("web").resolve("index.html"), "<html>")
        Files.writeString(
            userRoot.resolve("current.json"),
            "{\"version\":\"0.2.0+aaaaaaaaaaaa\",\"path\":\"0.2.0-aaaaaaaaaaaa\"}",
        )

        assertNull(RuntimeLayout.resolveFrom(emptyList(), userRoot))
    }

    @Test
    fun `blank version in current json skips user dir candidate`() {
        val userRoot = root.resolve("user-runtime")
        installUserRuntime(userRoot, "0.2.0+aaaaaaaaaaaa")
        Files.writeString(userRoot.resolve("current.json"), "{\"version\":\"\",\"path\":\"0.2.0-aaaaaaaaaaaa\"}")

        assertNull(RuntimeLayout.resolveFrom(emptyList(), userRoot))
    }

    // ---- BUILD-INFO 推导 runtimeVersion ----

    @Test
    fun `build info derives runtimeVersion`() {
        val dir = stagedRuntime(Files.createDirectories(root.resolve("rt")))
        writeBuildInfo(dir)

        val layout = RuntimeLayout.resolveFrom(listOf(dir), null)

        assertNotNull(layout)
        assertEquals("0.1.0+cf345dcb7d0a", layout!!.runtimeVersion, "取 fork.commit 前 12 位")
    }

    @Test
    fun `missing build info leaves runtimeVersion null`() {
        val dir = stagedRuntime(Files.createDirectories(root.resolve("rt")))

        val layout = RuntimeLayout.resolveFrom(listOf(dir), null)

        assertNotNull(layout)
        assertNull(layout!!.runtimeVersion)
    }

    @Test
    fun `build info with missing fields leaves runtimeVersion null`() {
        val dir = stagedRuntime(Files.createDirectories(root.resolve("rt")))
        writeBuildInfo(dir, commit = null) // fork.commit 缺失

        val layout = RuntimeLayout.resolveFrom(listOf(dir), null)
        assertNull(layout!!.runtimeVersion)

        val dir2 = stagedRuntime(Files.createDirectories(root.resolve("rt2")))
        writeBuildInfo(dir2, commit = "cf345dcb7d0af835951076bcd6192efeba6ecfa3")
        Files.writeString(dir2.resolve("BUILD-INFO.json"), "{\"fork\":{\"commit\":\"cf345dcb7d0a\"}}") // pluginVersion 缺失
        val layout2 = RuntimeLayout.resolveFrom(listOf(dir2), null)
        assertNull(layout2!!.runtimeVersion)
    }

    @Test
    fun `corrupt build info leaves runtimeVersion null`() {
        val dir = stagedRuntime(Files.createDirectories(root.resolve("rt")))
        Files.writeString(dir.resolve("BUILD-INFO.json"), "not json")

        val layout = RuntimeLayout.resolveFrom(listOf(dir), null)

        assertNotNull(layout)
        assertNull(layout!!.runtimeVersion)
    }

    // ---- 用户目录候选的入口文件校验（与 RuntimeProvisioner.validCurrentLayout 同口径） ----

    @Test
    fun `user dir candidate requires web index html`() {
        val userRoot = root.resolve("user-runtime")
        installUserRuntime(userRoot, "0.2.0+aaaaaaaaaaaa")
        Files.delete(userRoot.resolve("0.2.0-aaaaaaaaaaaa").resolve("web").resolve("index.html"))

        assertNull(RuntimeLayout.resolveFrom(emptyList(), userRoot))
        assertTrue(Files.isDirectory(userRoot.resolve("0.2.0-aaaaaaaaaaaa")))
    }
}
