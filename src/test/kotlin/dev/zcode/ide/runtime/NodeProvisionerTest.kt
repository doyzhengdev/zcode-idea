package dev.zcode.ide.runtime

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * [NodeProvisioner] 的纯文件系统逻辑：installRoot 布局、锁定版本下载路径（download/shasums 注入，
 * 不起网络）、旧版本保留语义、旧插件目录迁移。
 */
class NodeProvisionerTest {

    @TempDir
    lateinit var root: Path

    private fun sha256(file: Path): String {
        val digest = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(file).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    /** 写一个可被 extract() 接受的 Node 压缩包（Windows zip / 其他平台 tar.gz），顶层目录 node-v<version>。 */
    private fun writeNodeArchive(target: Path, version: String) {
        val topDir = "node-v$version"
        if (target.fileName.toString().endsWith(".zip")) {
            ZipOutputStream(Files.newOutputStream(target)).use { out ->
                out.putNextEntry(ZipEntry("$topDir/bin/node"))
                out.write("fake node".toByteArray())
                out.closeEntry()
                out.putNextEntry(ZipEntry("$topDir/README"))
                out.write("readme".toByteArray())
                out.closeEntry()
            }
        } else {
            val staging = Files.createTempDirectory("node-archive")
            try {
                Files.createDirectories(staging.resolve(topDir).resolve("bin"))
                Files.writeString(staging.resolve(topDir).resolve("bin").resolve("node"), "fake node")
                val process = ProcessBuilder(
                    "tar", "-czf", target.toString(), "-C", staging.toString(), topDir,
                ).redirectErrorStream(true).start()
                if (!process.waitFor(60, java.util.concurrent.TimeUnit.SECONDS) || process.exitValue() != 0) {
                    throw IOException("测试 tar 打包失败：" + process.inputStream.bufferedReader().readText())
                }
            } finally {
                staging.toFile().deleteRecursively()
            }
        }
    }

    /** 注入式安装：download 写出真实压缩包，shasums 返回其真实 sha256（与生产流程同样的校验路径）。 */
    private fun installPinned(version: String, root: Path): Path {
        var archivePath: Path? = null
        val downloadLog = mutableListOf<String>()
        return NodeProvisioner.installPinnedAt(
            root,
            version,
            { },
            download = { mirror, v, archiveName, target, _ ->
                downloadLog += "$mirror $v $archiveName"
                writeNodeArchive(target, v)
                archivePath = target
            },
            shasums = { _, _, archiveName ->
                // 生产实现返回 SHASUMS256.txt 全文；这里给出一行同格式的条目。
                "${sha256(archivePath!!)}  $archiveName"
            },
        ).also { assertEquals(listOf(version), downloadLog.map { entry -> entry.split(" ")[1] }, "应按锁定版本下载") }
    }

    // ---- installRoot ----

    @Test
    fun `install root is fixed under user data base directory`() {
        assertEquals(root.resolve(".zcode").resolve("ide").resolve("runtime-node"), NodeProvisioner.installRootAt(root))
    }

    // ---- 已装副本选取（评审 F2：只复用 24.x，历史污染的非 24 版本交由下载装回） ----

    private fun fakeNode(version: String): NodeRuntime =
        NodeRuntime(root.resolve("v$version").resolve("node"), version.substringBefore('.').toInt(), version)

    @Test
    fun `installed selection keeps only node 24 and picks the newest`() {
        val selected = NodeProvisioner.selectInstalled(
            listOf(fakeNode("22.23.4"), fakeNode("24.1.0"), fakeNode("24.19.0")),
        )
        assertEquals("24.19.0", selected?.version, "24.x 中取最高；非 24 一律过滤")
    }

    @Test
    fun `installed selection rejects non 24 versions instead of reusing them`() {
        assertNull(NodeProvisioner.selectInstalled(listOf(fakeNode("22.23.4"), fakeNode("25.1.0"))), "非 24 已装版本不得复用")
        assertNull(NodeProvisioner.selectInstalled(emptyList()))
    }

    // ---- 锁定版本下载路径 ----

    @Test
    fun `pinned version downloads exact version and extracts`() {
        val destination = installPinned("24.22.0", root)

        assertEquals(root.resolve("v24.22.0"), destination)
        assertTrue(Files.isRegularFile(destination.resolve("bin").resolve("node")))
        // 临时目录已清理
        val leftovers = Files.list(root).use { it.filter { p -> p.fileName.toString().startsWith(".tmp-") }.toList() }
        assertTrue(leftovers.isEmpty(), "安装后不应有 .tmp-* 残留：$leftovers")
    }

    @Test
    fun `pinned install keeps old versions but reinstalls same version dir`() {
        installPinned("24.1.0", root)
        Files.writeString(root.resolve("v24.1.0").resolve("keep.txt"), "keep me")

        installPinned("24.2.0", root)

        assertTrue(Files.isDirectory(root.resolve("v24.1.0")), "不同版本目录一律保留")
        assertEquals("keep me", Files.readString(root.resolve("v24.1.0").resolve("keep.txt")))
        assertTrue(Files.isRegularFile(root.resolve("v24.2.0").resolve("bin").resolve("node")))

        // 同名 v24.2.0 已存在 → 删除重装（旧内容不残留）
        Files.writeString(root.resolve("v24.2.0").resolve("stale.txt"), "old")
        installPinned("24.2.0", root)
        assertFalse(Files.exists(root.resolve("v24.2.0").resolve("stale.txt")), "同名版本应删除重装")
        assertTrue(Files.isRegularFile(root.resolve("v24.2.0").resolve("bin").resolve("node")))
        assertTrue(Files.isDirectory(root.resolve("v24.1.0")), "重装另一版本不影响旧版本")
    }

    @Test
    fun `pinned install falls back to next mirror when first fails`() {
        var calls = 0
        var archivePath: Path? = null
        val destination = NodeProvisioner.installPinnedAt(
            root,
            "24.22.0",
            { },
            download = { _, v, _, target, _ ->
                calls += 1
                if (calls == 1) throw IOException("mirror down")
                writeNodeArchive(target, v)
                archivePath = target
            },
            shasums = { _, _, archiveName -> "${sha256(archivePath!!)}  $archiveName" },
        )

        assertEquals(2, calls, "首个镜像失败后应回落到下一个镜像")
        assertTrue(Files.isRegularFile(destination.resolve("bin").resolve("node")))
    }

    @Test
    fun `pinned install throws when all mirrors fail`() {
        var calls = 0
        val error = assertThrows(IllegalStateException::class.java) {
            NodeProvisioner.installPinnedAt(
                root,
                "24.22.0",
                { },
                download = { _, _, _, _, _ -> calls += 1; throw IOException("mirror down") },
                shasums = { _, _, _ -> error("下载失败不应走到校验") },
            )
        }
        assertTrue(calls >= 2, "应尝试全部镜像（npmmirror → nodejs.org）：实际 $calls 次")
        assertTrue(error.message!!.contains("24.22.0"), error.message)
        assertTrue(error.message!!.contains("mirror down"), error.message)
    }

    // ---- 旧插件目录迁移（best-effort） ----

    @Test
    fun `legacy runtime-node versions are migrated to new install root`() {
        val legacy = Files.createDirectories(root.resolve("legacy").resolve("runtime-node").resolve("v24.1.0").resolve("bin"))
        Files.writeString(legacy.resolve("node"), "fake")
        val target = root.resolve("new-root")

        NodeProvisioner.migrateLegacyInstallationsAt(target, root.resolve("legacy").resolve("runtime-node"))

        assertTrue(Files.isRegularFile(target.resolve("v24.1.0").resolve("bin").resolve("node")), "版本目录应移入新根")
        assertFalse(Files.exists(root.resolve("legacy").resolve("runtime-node").resolve("v24.1.0")), "移动而非复制")
    }

    @Test
    fun `migration skips same-name dirs and marks done`() {
        val legacy = Files.createDirectories(root.resolve("legacy").resolve("runtime-node").resolve("v24.1.0"))
        Files.writeString(legacy.resolve("newer"), "legacy")
        val target = Files.createDirectories(root.resolve("new-root").resolve("v24.1.0"))
        Files.writeString(target.resolve("current"), "current")

        NodeProvisioner.migrateLegacyInstallationsAt(root.resolve("new-root"), root.resolve("legacy").resolve("runtime-node"))

        assertEquals("current", Files.readString(target.resolve("current")), "同名目录跳过，保留新目录")
        assertTrue(Files.exists(root.resolve("new-root").resolve(".migrated")), "迁移后写标记")
    }

    @Test
    fun `migration marker prevents repeat`() {
        val legacy = Files.createDirectories(root.resolve("legacy").resolve("runtime-node").resolve("v24.1.0"))
        Files.writeString(legacy.resolve("node"), "fake")
        val newRoot = root.resolve("new-root")

        NodeProvisioner.migrateLegacyInstallationsAt(newRoot, root.resolve("legacy").resolve("runtime-node"))
        assertTrue(Files.isRegularFile(newRoot.resolve("v24.1.0").resolve("node")))

        // 首次迁移后人为删掉迁移结果并改回 legacy：标记存在时不应再迁移。
        Files.delete(newRoot.resolve("v24.1.0").resolve("node"))
        NodeProvisioner.migrateLegacyInstallationsAt(newRoot, root.resolve("legacy").resolve("runtime-node"))
        assertFalse(Files.exists(newRoot.resolve("v24.1.0").resolve("node")), "有标记时不应重复迁移")
    }

    @Test
    fun `migration without legacy dir or versions is a no-op`() {
        val newRoot = root.resolve("new-root")
        // legacy 不存在
        NodeProvisioner.migrateLegacyInstallationsAt(newRoot, root.resolve("missing"))
        assertFalse(Files.exists(newRoot), "无可迁移内容不应创建新根")

        // legacy 存在但没有 v* 目录
        val legacyEmpty = Files.createDirectories(root.resolve("legacy-empty").resolve("runtime-node"))
        Files.writeString(legacyEmpty.resolve("README"), "x")
        NodeProvisioner.migrateLegacyInstallationsAt(newRoot, legacyEmpty)
        assertFalse(Files.exists(newRoot.resolve(".migrated")), "无版本目录时不写迁移标记")
    }
}
