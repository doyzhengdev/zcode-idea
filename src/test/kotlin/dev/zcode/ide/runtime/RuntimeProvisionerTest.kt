package dev.zcode.ide.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.io.TempDir
import java.io.IOException
import java.io.InputStream
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.FileTime
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class RuntimeProvisionerTest {

    @TempDir
    lateinit var root: Path

    /** 与 manifest 匹配的本地 zip（替代网络下载），返回 zip 与对应 manifest。 */
    private fun buildRuntimeZip(runtimeVersion: String): Pair<Path, RuntimeManifest> {
        val fixtures = Files.createDirectories(root.resolve("fixtures"))
        val zip = fixtures.resolve("zcode-runtime.zip")
        ZipOutputStream(Files.newOutputStream(zip)).use { out ->
            for (name in listOf(
                "server/entry-http.js",
                "web/index.html",
                "agent/zcode.cjs",
                "remote-bridge/index.mjs",
                "LICENSE",
                "NOTICE.md",
                "THIRD-PARTY-NOTICES.md",
                // darwin spawn-helper（含 node_modules 下）应被设为 0755
                "node_modules/spark/bin/darwin-x64/spawn-helper",
            )) {
                out.putNextEntry(ZipEntry(name))
                out.write("# $name".toByteArray())
                out.closeEntry()
            }
        }
        return zip to manifestFor(zip, runtimeVersion)
    }

    private fun manifestFor(zip: Path, runtimeVersion: String): RuntimeManifest {
        val digest = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(zip).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return RuntimeManifest(
            schemaVersion = 1,
            channel = "stable",
            runtimeVersion = runtimeVersion,
            runtimeApiVersion = 1,
            minPluginVersion = "0.1.0",
            maxPluginVersion = "0.1.*",
            nodeVersion = "24.14.0",
            archivePath = "test/zcode-runtime.zip",
            sha256 = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) },
            size = Files.size(zip),
            uncompressedSize = Files.size(zip) * 2,
            builtAt = "2026-10-25T00:00:00Z",
            forkCommit = "cf345dcb7d0a",
        )
    }

    private fun assertNoStagingLeftovers() {
        val leftovers = Files.list(root).use { stream ->
            stream.filter { it.fileName.toString().contains(".staging-") }.toList()
        }
        assertTrue(leftovers.isEmpty(), "staging 未清理：$leftovers")
    }

    private fun makeVersionDir(name: String, withComplete: Boolean): Path {
        val dir = root.resolve(name)
        Files.createDirectories(dir.resolve("server"))
        Files.writeString(dir.resolve("server").resolve("entry-http.js"), "x")
        if (withComplete) {
            Files.writeString(
                dir.resolve(".complete.json"),
                "{\"version\":\"${name.replaceFirst("-", "+")}\"," +
                    "\"sha256\":\"${"a".repeat(64)}\",\"size\":1,\"installedAt\":\"2026-10-25T00:00:00Z\"}",
            )
        }
        return dir
    }

    private fun writePointerJson(fileName: String, version: String, path: String) {
        Files.writeString(
            root.resolve(fileName),
            "{\"version\":\"$version\",\"path\":\"$path\"," +
                "\"sha256\":\"${"a".repeat(64)}\",\"installedAt\":\"2026-10-25T00:00:00Z\"}",
        )
    }

    // ---- 完整安装流程（下载由注入的本地 zip 替代，不起真网络） ----

    @Test
    fun `install from archive produces complete layout and pointers`() {
        val (zip, manifest) = buildRuntimeZip("0.1.0+cf345dcb7d0a")
        val statuses = mutableListOf<String>()

        val layout = RuntimeProvisioner.installFromArchive(root, manifest, zip) { statuses += it }

        val target = root.resolve(manifest.versionDir)
        assertTrue(Files.isDirectory(target))
        for (required in listOf(
            "server/entry-http.js",
            "web/index.html",
            "agent/zcode.cjs",
            "remote-bridge/index.mjs",
            "LICENSE",
            "NOTICE.md",
            "THIRD-PARTY-NOTICES.md",
        )) {
            assertTrue(Files.isRegularFile(target.resolve(required)), "缺少 $required")
        }

        assertEquals(target, layout.root)
        assertEquals(target.resolve("server/entry-http.js"), layout.serverEntry)
        assertEquals(target.resolve("web"), layout.webRoot)
        assertEquals(target.resolve("agent/zcode.cjs"), layout.agentEntry)
        assertEquals(target.resolve("remote-bridge/index.mjs"), layout.remoteBridgeEntry)

        // .complete.json
        val complete = Json.parseToJsonElement(Files.readString(target.resolve(".complete.json"))).jsonObject
        assertEquals(manifest.runtimeVersion, complete["version"]!!.jsonPrimitive.content)
        assertEquals(manifest.sha256, complete["sha256"]!!.jsonPrimitive.content)

        // current.json
        assertEquals(manifest.runtimeVersion, RuntimeProvisioner.currentVersionAt(root))
        val current = Json.parseToJsonElement(Files.readString(root.resolve("current.json"))).jsonObject
        assertEquals(manifest.versionDir, current["path"]!!.jsonPrimitive.content)
        assertEquals(manifest.runtimeVersion, current["version"]!!.jsonPrimitive.content)

        assertNoStagingLeftovers()
        assertFalse(Files.exists(root.resolve("${manifest.versionDir}.part")), "安装成功后 .part 应删除")

        // 状态顺序：校验在解压前
        val verifyIndex = statuses.indexOfFirst { it.contains("正在校验") }
        val extractIndex = statuses.indexOfFirst { it.contains("正在解压") }
        assertTrue(verifyIndex in 0 until extractIndex, "status 顺序错误：$statuses")

        // spawn-helper 权限（POSIX 文件系统上才有；Windows 正常路径跳过）
        if ("posix" in root.fileSystem.supportedFileAttributeViews()) {
            val helper = target.resolve("node_modules/spark/bin/darwin-x64/spawn-helper")
            assertEquals(
                PosixFilePermissions.fromString("rwxr-xr-x"),
                Files.getPosixFilePermissions(helper),
            )
        }
    }

    @Test
    fun `install fails and cleans staging when required file missing`() {
        val fixtures = Files.createDirectories(root.resolve("fixtures"))
        val zip = fixtures.resolve("incomplete.zip")
        ZipOutputStream(Files.newOutputStream(zip)).use { out ->
            // 只有 2 个必需文件
            for (name in listOf("server/entry-http.js", "web/index.html")) {
                out.putNextEntry(ZipEntry(name))
                out.write("x".toByteArray())
                out.closeEntry()
            }
        }
        val manifest = manifestFor(zip, "0.1.0+cf345dcb7d0a")

        val error = assertThrows(RuntimeProvisionException::class.java) {
            RuntimeProvisioner.installFromArchive(root, manifest, zip) { }
        }
        assertTrue(error.message!!.contains("缺少必需文件"), error.message)

        assertFalse(Files.exists(root.resolve(manifest.versionDir)))
        assertNoStagingLeftovers()
        assertNull(RuntimeProvisioner.currentVersionAt(root))
    }

    @Test
    fun `install fails on size or sha256 mismatch and removes bad archive`() {
        val (zip, manifest) = buildRuntimeZip("0.1.0+cf345dcb7d0a")
        val badManifest = manifest.copy(sha256 = "b".repeat(64))

        val error = assertThrows(RuntimeProvisionException::class.java) {
            RuntimeProvisioner.installFromArchive(root, badManifest, zip) { }
        }
        assertTrue(error.message!!.contains("校验失败"), error.message)
        assertFalse(Files.exists(zip), "校验失败的 archive（.part）应删除")
        assertFalse(Files.exists(root.resolve(manifest.versionDir)))
    }

    // ---- zip-slip ----

    @Test
    fun `zip slip entries are rejected and staging cleaned`() {
        val fixtures = Files.createDirectories(root.resolve("fixtures"))
        val zip = fixtures.resolve("evil.zip")
        ZipOutputStream(Files.newOutputStream(zip)).use { out ->
            out.putNextEntry(ZipEntry("server/entry-http.js"))
            out.write("x".toByteArray())
            out.closeEntry()
            // 相对路径越界
            out.putNextEntry(ZipEntry("../evil.txt"))
            out.write("evil".toByteArray())
            out.closeEntry()
            // 绝对路径（以 / 开头）
            out.putNextEntry(ZipEntry("/abs.txt"))
            out.write("abs".toByteArray())
            out.closeEntry()
        }
        val manifest = manifestFor(zip, "0.1.0+cf345dcb7d0a")

        val error = assertThrows(RuntimeProvisionException::class.java) {
            RuntimeProvisioner.installFromArchive(root, manifest, zip) { }
        }
        assertTrue(error.message!!.contains("非法"), error.message)

        assertNoStagingLeftovers()
        assertFalse(Files.exists(root.resolve(manifest.versionDir)))
        assertNull(RuntimeProvisioner.currentVersionAt(root))
        // 越界文件没有被写出来
        assertFalse(Files.exists(root.resolve("evil.txt")))
        assertFalse(Files.exists(root.resolve("abs.txt")))
    }

    @Test
    fun `zip slip windows style entries are rejected and nothing escapes`() {
        // 方案 §10.1「zip entry 路径校验」的 Windows 风格补充：反斜杠相对越界 + 盘符绝对路径。
        val fixtures = Files.createDirectories(root.resolve("fixtures"))
        val zip = fixtures.resolve("evil-windows.zip")
        ZipOutputStream(Files.newOutputStream(zip)).use { out ->
            out.putNextEntry(ZipEntry("server/entry-http.js"))
            out.write("x".toByteArray())
            out.closeEntry()
            // Windows 反斜杠相对越界：Windows 上 `\` 是分隔符，`staging\..\evil.txt` 越出 staging；
            // POSIX 上反斜杠是合法文件名字符，该条目落为 staging 内字面文件名（不越界，放行）。
            out.putNextEntry(ZipEntry("..\\evil.txt"))
            out.write("evil".toByteArray())
            out.closeEntry()
            // Windows 盘符绝对路径：safeEntryTarget 的盘符分支，所有平台都拒绝。
            out.putNextEntry(ZipEntry("C:\\evil-abs.txt"))
            out.write("evil".toByteArray())
            out.closeEntry()
        }
        val manifest = manifestFor(zip, "0.1.0+cf345dcb7d0a")

        // 盘符条目在所有平台都非法 → 必然抛错；Windows 上先撞反斜杠条目，POSIX 上先撞盘符条目。
        val error = assertThrows(RuntimeProvisionException::class.java) {
            RuntimeProvisioner.installFromArchive(root, manifest, zip) { }
        }
        assertTrue(error.message!!.contains("非法"), error.message)
        if ("posix" in root.fileSystem.supportedFileAttributeViews()) {
            assertTrue(error.message!!.contains("C:"), error.message)
        } else {
            assertTrue(error.message!!.contains("..\\evil.txt"), error.message)
        }

        // 越界文件没有被写出来（`..\evil.txt` 在 Windows 上越出 staging 后落在 runtime 根）
        assertFalse(Files.exists(root.resolve("evil.txt")))
        assertNoStagingLeftovers()
        assertFalse(Files.exists(root.resolve(manifest.versionDir)))
        assertNull(RuntimeProvisioner.currentVersionAt(root))
    }

    // ---- 同版本已完整：直接认领，不重新解压 ----

    @Test
    fun `complete version dir is adopted without re-extraction`() {
        val (zip, manifest) = buildRuntimeZip("0.1.0+cf345dcb7d0a")
        RuntimeProvisioner.installFromArchive(root, manifest, zip) { }

        // 模拟「解压成功但指针没写」：删掉 current.json，放一个标记文件
        Files.delete(root.resolve("current.json"))
        val marker = root.resolve(manifest.versionDir).resolve("marker.txt")
        Files.writeString(marker, "keep")

        val layout = RuntimeProvisioner.installFromArchive(root, manifest, zip) { }

        // 没有重新解压（标记文件还在），指针恢复
        assertEquals("keep", Files.readString(marker))
        assertEquals(root.resolve(manifest.versionDir), layout.root)
        assertEquals(manifest.runtimeVersion, RuntimeProvisioner.currentVersionAt(root))
    }

    // ---- 指针与决策链（ensureAt） ----

    @Test
    fun `invalid current pointer falls through to download branch`() {
        Files.writeString(root.resolve("current.json"), "{ broken json")
        val (zip, manifest) = buildRuntimeZip("0.1.0+cf345dcb7d0a")
        var downloadCalled = false

        val layout = RuntimeProvisioner.ensureAt(root, manifest, { }) { _, _, _ ->
            downloadCalled = true
            zip
        }

        assertTrue(downloadCalled, "坏 current.json 应退化为下载分支")
        assertEquals(root.resolve(manifest.versionDir), layout.root)
        assertEquals(manifest.runtimeVersion, RuntimeProvisioner.currentVersionAt(root))
    }

    @Test
    fun `valid current pointer short circuits download`() {
        val (zip, manifest) = buildRuntimeZip("0.1.0+cf345dcb7d0a")
        RuntimeProvisioner.installFromArchive(root, manifest, zip) { }
        var downloadCalled = false

        val layout = RuntimeProvisioner.ensureAt(root, manifest, { }) { _, _, _ ->
            downloadCalled = true
            error("不应触发下载")
        }

        assertFalse(downloadCalled)
        assertEquals(root.resolve(manifest.versionDir), layout.root)
    }

    @Test
    fun `missing baseline fails with offline hint`() {
        val error = assertThrows(RuntimeProvisionException::class.java) {
            RuntimeProvisioner.ensureAt(root, null, { }) { _, _, _ -> error("不应触发下载") }
        }
        val message = error.message!!
        assertTrue(message.contains("ZCODE_IDE_RUNTIME"), message)
        assertTrue(message.contains("完整"), message)
    }

    @Test
    fun `currentVersionAt returns null on missing or broken pointer`() {
        assertNull(RuntimeProvisioner.currentVersionAt(root))
        Files.writeString(root.resolve("current.json"), "not json")
        assertNull(RuntimeProvisioner.currentVersionAt(root))
    }

    // ---- 文件锁：同 JVM 重入（OverlappingFileLockException）按锁被占处理 ----

    @Test
    @Timeout(30)
    fun `overlapping lock in same jvm waits and adopts current when ready`() {
        val (zip, manifest) = buildRuntimeZip("0.1.0+cf345dcb7d0a")
        // 同 JVM 内先持有 .lock（模拟另一进程/线程正在下载）：此时 tryLock 会抛
        // OverlappingFileLockException 而不是返回 null，修复前这里直接崩、不进等待循环。
        val lockChannel = FileChannel.open(
            root.resolve(".lock"),
            StandardOpenOption.CREATE,
            StandardOpenOption.READ,
            StandardOpenOption.WRITE,
        )
        val heldLock = lockChannel.lock()
        var sawWaitStatus = false
        try {
            var downloadCalled = false
            val layout = RuntimeProvisioner.downloadAndInstall(root, manifest, { status ->
                if (status.contains("等待中")) {
                    sawWaitStatus = true
                    // 模拟持锁方装完：写完整版本目录 + current.json，下一轮轮询应命中。
                    RuntimeProvisioner.installFromArchive(root, manifest, zip) { }
                }
            }) { _, _, _ ->
                downloadCalled = true
                error("不应触发下载")
            }

            assertTrue(sawWaitStatus, "重入应进入等待并提示，status 收到过的回调里应有等待文案")
            assertFalse(downloadCalled, "等待期间 current 就绪，不应走到下载")
            assertEquals(root.resolve(manifest.versionDir), layout.root)
            assertEquals(manifest.runtimeVersion, RuntimeProvisioner.currentVersionAt(root))
        } finally {
            runCatching { heldLock.release() }
            runCatching { lockChannel.close() }
        }
    }

    // ---- 下载停滞看门狗（读超时 60s 的落地；阈值注入，不起真网络） ----

    /** 发 [prefixBytes] 字节后停滞的流：close()（看门狗触发）会打断阻塞中的 read 并转成 IOException。 */
    private fun stalledInputStream(prefixBytes: Int): InputStream = object : InputStream() {
        private var sent = 0
        private var readerThread: Thread? = null

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            readerThread = Thread.currentThread()
            if (sent >= prefixBytes) {
                // 停滞：不再有数据也不关流（模拟远端挂起）。
                try {
                    Thread.sleep(30_000)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw IOException("stream closed by watchdog", e)
                }
                return -1
            }
            val n = minOf(len, prefixBytes - sent)
            for (i in 0 until n) b[off + i] = 'x'.toInt().toByte()
            sent += n
            return n
        }

        override fun read(): Int {
            val one = ByteArray(1)
            val n = read(one, 0, 1)
            return if (n < 0) -1 else one[0].toInt()
        }

        override fun close() {
            readerThread?.interrupt()
        }
    }

    @Test
    @Timeout(15)
    fun `read watchdog aborts stalled download and keeps part file`() {
        val partFile = root.resolve("0.1.0-abc.part")
        val prefixBytes = 512

        val error = assertThrows(RuntimeProvisionException::class.java) {
            RuntimeProvisioner.readDownloadBody(
                partFile,
                stalledInputStream(prefixBytes),
                append = false,
                total = 1024,
                status = { },
                stallTimeoutMs = 300,
            )
        }
        assertTrue(error.message!!.contains("停滞"), error.message)

        // 停滞按下载失败语义处理：已写入 .part 的字节保留，重试续传。
        assertTrue(Files.exists(partFile), "停滞中止后 .part 应保留供续传")
        assertEquals(prefixBytes.toLong(), Files.size(partFile))
    }

    @Test
    @Timeout(15)
    fun `read watchdog does not fire while data keeps arriving`() {
        val partFile = root.resolve("0.1.0-def.part")
        // 每次最多喂 8 字节、每片停 100ms（< 300ms 阈值）：全程约 1.3s，
        // 必然跨过看门狗的首次巡检（300ms）与多个巡检周期——验证健康慢流不被误杀。
        // close 语义与 stalledInputStream 相同：若看门狗误杀（close 打断 read → IOException），
        // readDownloadBody 会判为停滞抛错、用例失败——「误杀仍通过」的判别力漏洞由此闭合。
        val slowInput = object : InputStream() {
            private var sent = 0
            private var readerThread: Thread? = null
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                readerThread = Thread.currentThread()
                if (sent >= 96) return -1
                try {
                    Thread.sleep(100)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw IOException("stream closed by watchdog", e)
                }
                val n = minOf(8, len, 96 - sent)
                for (i in 0 until n) b[off + i] = 'y'.toInt().toByte()
                sent += n
                return n
            }

            override fun read(): Int {
                val one = ByteArray(1)
                val n = read(one, 0, 1)
                return if (n < 0) -1 else one[0].toInt()
            }

            override fun close() {
                readerThread?.interrupt()
            }
        }

        RuntimeProvisioner.readDownloadBody(
            partFile,
            slowInput,
            append = false,
            total = 96,
            status = { },
            stallTimeoutMs = 300,
        )

        assertEquals(96L, Files.size(partFile))
    }

    // ---- cleanup ----

    @Test
    fun `cleanup keeps current pending previous and removes the rest`() {
        makeVersionDir("0.2.0-a", withComplete = true)       // current
        makeVersionDir("0.3.0-b", withComplete = true)       // pending
        makeVersionDir("0.1.0-old", withComplete = true)     // current 的上一版
        makeVersionDir("0.0.9-ancient", withComplete = true) // 更旧的版本
        makeVersionDir("0.9.0-future", withComplete = true)  // 无主的新版本
        makeVersionDir("garbage", withComplete = false)      // 缺 .complete.json 的垃圾目录
        writePointerJson("current.json", "0.2.0+aaaaaaaaaaaa", "0.2.0-a")
        writePointerJson("pending.json", "0.3.0+bbbbbbbbbbbb", "0.3.0-b")

        RuntimeProvisioner.cleanupAt(root, keepCurrent = true, keepPending = true, keepPreviousOne = true)

        assertTrue(Files.isDirectory(root.resolve("0.2.0-a")), "current 应保留")
        assertTrue(Files.isDirectory(root.resolve("0.3.0-b")), "pending 应保留")
        assertTrue(Files.isDirectory(root.resolve("0.1.0-old")), "上一版应保留")
        assertFalse(Files.exists(root.resolve("0.0.9-ancient")), "更旧版本应删除")
        assertFalse(Files.exists(root.resolve("0.9.0-future")), "无主版本应删除")
        assertFalse(Files.exists(root.resolve("garbage")), "垃圾目录应删除")
    }

    @Test
    fun `cleanup keep flags degrade`() {
        makeVersionDir("0.2.0-a", withComplete = true)
        makeVersionDir("0.1.0-old", withComplete = true)
        writePointerJson("current.json", "0.2.0+aaaaaaaaaaaa", "0.2.0-a")

        // 不保留上一版
        RuntimeProvisioner.cleanupAt(root, keepCurrent = true, keepPending = true, keepPreviousOne = false)
        assertTrue(Files.isDirectory(root.resolve("0.2.0-a")))
        assertFalse(Files.exists(root.resolve("0.1.0-old")))

        // 不保留 current（指针文件本身保留，指向的目录删除）
        makeVersionDir("0.1.0-old", withComplete = true)
        RuntimeProvisioner.cleanupAt(root, keepCurrent = false, keepPending = true, keepPreviousOne = false)
        assertFalse(Files.exists(root.resolve("0.2.0-a")))
        assertFalse(Files.exists(root.resolve("0.1.0-old")))
    }

    @Test
    fun `cleanup removes expired part files only`() {
        val fresh = Files.writeString(root.resolve("0.1.0-abc.part"), "x")
        val stale = Files.writeString(root.resolve("0.0.9-old.part"), "x")
        Files.setLastModifiedTime(stale, FileTime.from(Instant.now().minus(Duration.ofDays(8))))

        RuntimeProvisioner.cleanupAt(root, keepCurrent = true, keepPending = true, keepPreviousOne = true)

        assertTrue(Files.exists(fresh), "未过期的 .part 应保留")
        assertFalse(Files.exists(stale), "超过 7 天的 .part 应删除")
    }

    // ---- 指针原子写契约（§10.1「current/pending 原子写」）：覆盖写生效、无临时文件残留 ----

    @Test
    fun `pointer atomic write replaces content and leaves no temp files`() {
        val pointer = RuntimeProvisioner.Pointer(
            version = "0.1.0+aaaaaaaaaaaa",
            path = "0.1.0-a",
            sha256 = "a".repeat(64),
            installedAt = "2026-10-25T00:00:00Z",
        )

        // 同名指针重复写（覆盖既有文件）与 pending 写路径都走 atomicWriteJson
        RuntimeProvisioner.writeCurrentPointer(root, pointer)
        RuntimeProvisioner.writeCurrentPointer(root, pointer.copy(version = "0.2.0+bbbbbbbbbbbb"))
        RuntimeProvisioner.writePendingPointer(root, pointer)

        // 覆盖写语义：最后一次写生效，不是追加或失败
        assertEquals("0.2.0+bbbbbbbbbbbb", RuntimeProvisioner.currentVersionAt(root))
        assertEquals("0.1.0+aaaaaaaaaaaa", RuntimeProvisioner.readPendingPointer(root)!!.version)

        // 临时文件（.tmp-<uuid>）必须在 finally 中清理，不得残留成垃圾
        val leftovers = Files.list(root).use { stream ->
            stream.map { it.fileName.toString() }.filter { it.startsWith(".tmp-") }.toList()
        }
        assertTrue(leftovers.isEmpty(), "原子写不应残留临时文件：$leftovers")
    }

    // ---- pending 指针（ZCodeServerManager 的 pending 优先启动，方案 §6.3 启动侧） ----

    @Test
    fun `validPendingPointer returns pointer for valid pending`() {
        makeVersionDir("0.3.0-b", withComplete = true)
        writePointerJson("pending.json", "0.3.0+bbbbbbbbbbbb", "0.3.0-b")

        val pending = RuntimeProvisioner.validPendingPointer(root)

        assertNotNull(pending)
        assertEquals("0.3.0+bbbbbbbbbbbb", pending!!.version)
        assertEquals("0.3.0-b", pending.path)
    }

    @Test
    fun `validPendingPointer rejects broken or missing pointer`() {
        assertNull(RuntimeProvisioner.validPendingPointer(root), "pending.json 缺失应返回 null")

        Files.writeString(root.resolve("pending.json"), "{ broken json")
        assertNull(RuntimeProvisioner.validPendingPointer(root), "坏 JSON 应返回 null")
    }

    @Test
    fun `validPendingPointer rejects blank version or unsafe path`() {
        makeVersionDir("0.3.0-b", withComplete = true)

        writePointerJson("pending.json", "", "0.3.0-b")
        assertNull(RuntimeProvisioner.validPendingPointer(root), "version 为空应返回 null")

        writePointerJson("pending.json", "0.3.0+bbbbbbbbbbbb", "../escape")
        assertNull(RuntimeProvisioner.validPendingPointer(root), "越界 path 应返回 null")

        writePointerJson("pending.json", "0.3.0+bbbbbbbbbbbb", "sub/0.3.0-b")
        assertNull(RuntimeProvisioner.validPendingPointer(root), "带分隔符的 path 应返回 null")

        writePointerJson("pending.json", "0.3.0+bbbbbbbbbbbb", "..")
        assertNull(RuntimeProvisioner.validPendingPointer(root), "path 为 .. 应返回 null")
    }

    @Test
    fun `validPendingPointer rejects missing or incomplete version dir`() {
        writePointerJson("pending.json", "0.3.0+bbbbbbbbbbbb", "0.3.0-b")
        assertNull(RuntimeProvisioner.validPendingPointer(root), "版本目录缺失应返回 null")

        makeVersionDir("0.3.0-b", withComplete = false)
        assertNull(RuntimeProvisioner.validPendingPointer(root), "缺 .complete.json 应返回 null")
    }

    @Test
    fun `promote writes current pointer and removes pending`() {
        makeVersionDir("0.2.0-a", withComplete = true)   // 原 current
        makeVersionDir("0.3.0-b", withComplete = true)   // pending
        writePointerJson("current.json", "0.2.0+aaaaaaaaaaaa", "0.2.0-a")
        writePointerJson("pending.json", "0.3.0+bbbbbbbbbbbb", "0.3.0-b")

        val pending = RuntimeProvisioner.readPendingPointer(root)!!
        val promoted = RuntimeProvisioner.promotePendingPointer(root, pending)

        assertTrue(promoted)
        // current.json ← pending 内容（原子写）
        assertEquals("0.3.0+bbbbbbbbbbbb", RuntimeProvisioner.currentVersionAt(root))
        val current = Json.parseToJsonElement(Files.readString(root.resolve("current.json"))).jsonObject
        assertEquals("0.3.0-b", current["path"]!!.jsonPrimitive.content)
        // pending.json 已删除；两个版本目录都在（目录处理交给随后的 cleanup）
        assertFalse(Files.exists(root.resolve("pending.json")))
        assertTrue(Files.isDirectory(root.resolve("0.3.0-b")))
        assertTrue(Files.isDirectory(root.resolve("0.2.0-a")))
    }

    @Test
    fun `rollback removes pending json and keeps version dir`() {
        makeVersionDir("0.3.0-b", withComplete = true)
        writePointerJson("pending.json", "0.3.0+bbbbbbbbbbbb", "0.3.0-b")

        val rolledBack = RuntimeProvisioner.rollbackPendingPointer(root)

        assertTrue(rolledBack)
        assertFalse(Files.exists(root.resolve("pending.json")), "pending.json 应删除")
        assertTrue(Files.isDirectory(root.resolve("0.3.0-b")), "版本目录保留供排查")
    }

    @Test
    fun `rollback without pending json is idempotent`() {
        assertTrue(RuntimeProvisioner.rollbackPendingPointer(root))
        assertFalse(Files.exists(root.resolve("pending.json")))
    }

    @Test
    fun `promote returns false and keeps pending when current pointer cannot be written`() {
        makeVersionDir("0.3.0-b", withComplete = true)
        writePointerJson("pending.json", "0.3.0+bbbbbbbbbbbb", "0.3.0-b")
        // current.json 的位置被目录占住 → 写 current 指针必然失败
        Files.createDirectories(root.resolve("current.json"))

        val pending = RuntimeProvisioner.readPendingPointer(root)!!
        val promoted = RuntimeProvisioner.promotePendingPointer(root, pending)

        assertFalse(promoted)
        assertTrue(Files.exists(root.resolve("pending.json")), "promote 失败不应删除 pending.json")
        assertNull(RuntimeProvisioner.currentVersionAt(root), "current 指针未被改写")
        assertTrue(Files.isDirectory(root.resolve("0.3.0-b")), "pending 版本目录应保留")
    }

    // ---- 运行时源协议放行（方案 §8.3：https 恒放行；http 仅显式调试开关） ----

    @Test
    fun `https 源恒放行而 http 默认拒绝`() {
        System.clearProperty(RuntimeSettings.KEY_ALLOW_HTTP)
        assertTrue(RuntimeSettings.isAllowedSourceUrl("https://cdn.example.com/zcode-ide/x.zip"))
        assertFalse(
            RuntimeSettings.isAllowedSourceUrl("http://tnbe4cmeo.hn-bkt.clouddn.com/zcode-ide/x.zip"),
            "默认必须拒绝 http，避免生产误用测试域名",
        )
        assertFalse(RuntimeSettings.isAllowedSourceUrl("ftp://example.com/x.zip"))
    }

    @Test
    fun `显式开关打开后放行 http 但仍拒绝其它协议`() {
        System.setProperty(RuntimeSettings.KEY_ALLOW_HTTP, "1")
        try {
            assertTrue(RuntimeSettings.allowInsecureHttp())
            assertTrue(RuntimeSettings.isAllowedSourceUrl("http://tnbe4cmeo.hn-bkt.clouddn.com/zcode-ide/x.zip"))
            assertTrue(RuntimeSettings.isAllowedSourceUrl("https://cdn.example.com/zcode-ide/x.zip"))
            assertFalse(RuntimeSettings.isAllowedSourceUrl("ftp://example.com/x.zip"))
        } finally {
            System.clearProperty(RuntimeSettings.KEY_ALLOW_HTTP)
        }
    }

    @Test
    fun `开关取值只认显式真值`() {
        try {
            System.setProperty(RuntimeSettings.KEY_ALLOW_HTTP, "true")
            assertTrue(RuntimeSettings.allowInsecureHttp())
            System.setProperty(RuntimeSettings.KEY_ALLOW_HTTP, "0")
            assertFalse(RuntimeSettings.allowInsecureHttp())
            System.setProperty(RuntimeSettings.KEY_ALLOW_HTTP, " ")
            assertFalse(RuntimeSettings.allowInsecureHttp())
        } finally {
            System.clearProperty(RuntimeSettings.KEY_ALLOW_HTTP)
        }
    }

    @Test
    fun `warnInsecureOnce 在无 platform 环境不抛错`() {
        // 单测环境没有 IntelliJ platform，Logger 获取失败应被 runCatching 兜底吞掉。
        RuntimeSettings.warnInsecureOnce("http://tnbe4cmeo.hn-bkt.clouddn.com/zcode-ide/x.zip")
    }
}
