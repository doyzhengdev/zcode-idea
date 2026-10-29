package dev.zcode.ide.runtime

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class RuntimeManifestTest {

    /** 字段齐全的样例 manifest，个别字段按参数覆盖。 */
    private fun manifest(
        schemaVersion: Int = 1,
        runtimeVersion: String = "0.1.0+cf345dcb7d0a",
        runtimeApiVersion: Int = 1,
        minPluginVersion: String = "0.1.0",
        maxPluginVersion: String = "0.1.*",
        sha256: String = "a".repeat(64),
        size: Long = 1024L,
    ): RuntimeManifest = RuntimeManifest(
        schemaVersion = schemaVersion,
        channel = "stable",
        runtimeVersion = runtimeVersion,
        runtimeApiVersion = runtimeApiVersion,
        minPluginVersion = minPluginVersion,
        maxPluginVersion = maxPluginVersion,
        nodeVersion = "24.14.0",
        archivePath = "zcode-ide/runtime/stable/0.1.0-cf345dcb7d0a/zcode-runtime.zip",
        sha256 = sha256,
        size = size,
        uncompressedSize = 195080934L,
        builtAt = "2026-10-25T07:28:29.739Z",
        forkCommit = "cf345dcb7d0af835951076bcd6192efeba6ecfa3",
    )

    // ---- baseline 与 parse ----

    @Test
    fun `parses bundled baseline manifest`() {
        val baseline = RuntimeManifest.loadBaseline()
        assertNotNull(baseline)
        baseline!!
        // 静态契约字段：精确断言。
        assertEquals(1, baseline.schemaVersion)
        assertEquals("stable", baseline.channel)
        assertEquals(1, baseline.runtimeApiVersion)
        assertEquals("0.1.0", baseline.minPluginVersion)
        assertEquals("0.1.*", baseline.maxPluginVersion)
        assertEquals("24.14.0", baseline.nodeVersion)
        assertEquals("", baseline.notes)
        // 动态字段（随 dist 重建变化）：结构一致性断言，不硬编码具体版本。
        assertTrue(baseline.forkCommit.matches(Regex("[0-9a-f]{40}")), "forkCommit 应为 40 位 hex：${baseline.forkCommit}")
        assertEquals("${RuntimeManifest.PLUGIN_VERSION}+${baseline.forkCommit.take(12)}", baseline.runtimeVersion)
        assertEquals(
            "zcode-ide/runtime/stable/${baseline.runtimeVersion.replace('+', '-')}/zcode-runtime.zip",
            baseline.archivePath,
        )
        assertTrue(baseline.size > 0)
        assertTrue(baseline.uncompressedSize >= baseline.size)
        assertTrue(baseline.sha256.matches(Regex("[0-9a-f]{64}")))
    }

    @Test
    fun `currentPluginVersion matches gradle pluginVersion`() {
        assertEquals("0.1.0", RuntimeManifest.currentPluginVersion())
        assertEquals(RuntimeManifest.PLUGIN_VERSION, RuntimeManifest.currentPluginVersion())
    }

    @Test
    fun `PLUGIN_VERSION matches gradle properties`() {
        // Gradle 测试的工作目录是模块根：按相对路径读 gradle.properties 与硬编码常量对账。
        // 升插件版本只改 gradle.properties 而漏改 RuntimeManifest.PLUGIN_VERSION 时，
        // baseline 兼容判断（min/maxPluginVersion）会错位，更新静默停摆——在这里直接 fail。
        val text = File("gradle.properties").readText()
        val gradleVersion = text.lineSequence()
            .map { it.substringBefore('#').trim() }
            .firstOrNull { it.startsWith("pluginVersion=") }
            ?.removePrefix("pluginVersion=")
            ?.trim()
        assertNotNull(gradleVersion, "gradle.properties 里应有一行 pluginVersion=…")
        assertEquals(gradleVersion, RuntimeManifest.PLUGIN_VERSION)
    }

    @Test
    fun `parse ignores unknown fields`() {
        val json = """
            {"schemaVersion":1,"channel":"stable","runtimeVersion":"0.1.0+abc","runtimeApiVersion":1,
             "minPluginVersion":"0.1.0","maxPluginVersion":"0.1.*","nodeVersion":"24.14.0",
             "archivePath":"x/zcode-runtime.zip","sha256":"${"a".repeat(64)}","size":1,
             "uncompressedSize":2,"builtAt":"t","forkCommit":"c","notes":"n","unknownField":123}
        """.trimIndent()
        val parsed = RuntimeManifest.parse(json.toByteArray())
        assertNotNull(parsed)
        assertEquals("0.1.0+abc", parsed!!.runtimeVersion)
    }

    @Test
    fun `parse defaults notes to empty when missing`() {
        val parsed = RuntimeManifest.parse(fullJsonWithout("notes").toByteArray())
        assertNotNull(parsed)
        assertEquals("", parsed!!.notes)
    }

    @Test
    fun `parse returns null when required field missing`() {
        assertNull(RuntimeManifest.parse(fullJsonWithout("sha256").toByteArray()))
        assertNull(RuntimeManifest.parse(fullJsonWithout("runtimeVersion").toByteArray()))
        assertNull(RuntimeManifest.parse("""{"schemaVersion":1,"channel":"stable"}""".toByteArray()))
    }

    @Test
    fun `parse returns null on broken json`() {
        assertNull(RuntimeManifest.parse("{ not json".toByteArray()))
        assertNull(RuntimeManifest.parse(byteArrayOf()))
    }

    private fun fullJsonWithout(vararg without: String): String {
        val fields = mapOf(
            "schemaVersion" to "1",
            "channel" to "\"stable\"",
            "runtimeVersion" to "\"0.1.0+abc\"",
            "runtimeApiVersion" to "1",
            "minPluginVersion" to "\"0.1.0\"",
            "maxPluginVersion" to "\"0.1.*\"",
            "nodeVersion" to "\"24.14.0\"",
            "archivePath" to "\"x/zcode-runtime.zip\"",
            "sha256" to "\"${"a".repeat(64)}\"",
            "size" to "1",
            "uncompressedSize" to "2",
            "builtAt" to "\"t\"",
            "forkCommit" to "\"c\"",
            "notes" to "\"n\"",
        ).filterKeys { it !in without }
        return fields.entries.joinToString(",", "{", "}") { "\"${it.key}\":${it.value}" }
    }

    // ---- versionDir ----

    @Test
    fun `versionDir replaces plus with dash`() {
        assertEquals("0.1.0-cf345dcb7d0a", manifest().versionDir)
        assertEquals("1.2.3", manifest(runtimeVersion = "1.2.3").versionDir)
    }

    // ---- isNewerThan ----

    @Test
    fun `isNewerThan compares only numeric triple`() {
        val older = manifest(runtimeVersion = "0.1.0+abc")
        val newer = manifest(runtimeVersion = "0.1.1+def")

        assertTrue(newer.isNewerThan(older))
        assertFalse(older.isNewerThan(newer))
    }

    @Test
    fun `isNewerThan ignores commit hash`() {
        // commit hash 无序：同数字版本互不为新（同版本不重装）
        val a = manifest(runtimeVersion = "0.1.0+abc")
        val b = manifest(runtimeVersion = "0.1.0+xyz")
        assertFalse(a.isNewerThan(b))
        assertFalse(b.isNewerThan(a))
    }

    @Test
    fun `isNewerThan numeric ordering`() {
        assertTrue(manifest(runtimeVersion = "0.2.0").isNewerThan(manifest(runtimeVersion = "0.1.99")))
        assertFalse(manifest(runtimeVersion = "0.1.99").isNewerThan(manifest(runtimeVersion = "0.2.0")))
        assertFalse(manifest(runtimeVersion = "0.0.9").isNewerThan(manifest(runtimeVersion = "0.1.0")))
    }

    @Test
    fun `isNewerThan returns false on broken numeric part`() {
        val normal = manifest(runtimeVersion = "0.1.0")
        val broken = manifest(runtimeVersion = "garbage+abc")
        val twoParts = manifest(runtimeVersion = "0.1")

        assertFalse(broken.isNewerThan(normal))
        assertFalse(normal.isNewerThan(broken))
        assertFalse(twoParts.isNewerThan(normal))
        assertFalse(broken.isNewerThan(twoParts))
    }

    // ---- isCompatible ----

    @Test
    fun `isCompatible accepts valid manifest`() {
        assertTrue(manifest().isCompatible("0.1.0"))
        // max 0.1.*：patch 任意
        assertTrue(manifest().isCompatible("0.1.9"))
        // min 之下仍可满足（min <= plugin < max）
        assertTrue(manifest(minPluginVersion = "0.0.9").isCompatible("0.1.0"))
    }

    @Test
    fun `isCompatible rejects wrong schemaVersion`() {
        assertFalse(manifest(schemaVersion = 2).isCompatible("0.1.0"))
    }

    @Test
    fun `isCompatible rejects wrong runtimeApiVersion`() {
        assertFalse(manifest(runtimeApiVersion = 2).isCompatible("0.1.0"))
    }

    @Test
    fun `isCompatible rejects plugin below minPluginVersion`() {
        assertFalse(manifest(minPluginVersion = "0.2.0").isCompatible("0.1.0"))
        // 相等不算低于 min
        assertTrue(manifest(minPluginVersion = "0.1.0").isCompatible("0.1.0"))
    }

    @Test
    fun `isCompatible rejects plugin outside maxPluginVersion wildcard`() {
        // 0.2.0 不匹配 0.1.*
        assertFalse(manifest().isCompatible("0.2.0"))
        // max 段数不足（plugin 位数超出）
        assertFalse(manifest(maxPluginVersion = "0.1").isCompatible("0.1.5"))
        // max 非数字段
        assertFalse(manifest(maxPluginVersion = "x.y.*").isCompatible("0.1.0"))
    }

    @Test
    fun `isCompatible rejects bad sha256`() {
        assertFalse(manifest(sha256 = "abc").isCompatible("0.1.0"))
        assertFalse(manifest(sha256 = "g".repeat(64)).isCompatible("0.1.0"))
        assertFalse(manifest(sha256 = "a".repeat(63)).isCompatible("0.1.0"))
    }

    @Test
    fun `isCompatible rejects non positive size`() {
        assertFalse(manifest(size = 0).isCompatible("0.1.0"))
        assertFalse(manifest(size = -1).isCompatible("0.1.0"))
    }
}
