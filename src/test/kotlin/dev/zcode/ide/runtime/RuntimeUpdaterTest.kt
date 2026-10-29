package dev.zcode.ide.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.util.Base64
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * RuntimeUpdater 的单测：全部注入 internal 注入点（HTTP 拉取、持久化、公钥、runtime 根、
 * runtime zip 下载），不起真网络、不碰真实用户目录（`~/.zcode`）。
 */
class RuntimeUpdaterTest {

    @TempDir
    lateinit var root: Path

    // JUnit 5 每个用例新建测试实例：在用例修改前捕获默认实现，@AfterEach 恢复，防注入泄漏到其他用例。
    private val defaultHttpFetch = RuntimeUpdater.httpFetch
    private val defaultStore = RuntimeUpdater.store
    private val defaultPublicKeyProvider = RuntimeUpdater.publicKeyProvider
    private val defaultRuntimeRoot = RuntimeUpdater.runtimeRoot
    private val defaultNotifyFn = RuntimeUpdater.notifyFn
    private val defaultDownloadImpl = RuntimeProvisioner.downloadImpl

    @AfterEach
    fun restoreDefaults() {
        RuntimeUpdater.httpFetch = defaultHttpFetch
        RuntimeUpdater.store = defaultStore
        RuntimeUpdater.publicKeyProvider = defaultPublicKeyProvider
        RuntimeUpdater.runtimeRoot = defaultRuntimeRoot
        RuntimeUpdater.notifyFn = defaultNotifyFn
        RuntimeProvisioner.downloadImpl = defaultDownloadImpl
        System.clearProperty("ZCODE_IDE_RUNTIME_AUTO_UPDATE")
        System.clearProperty("ZCODE_IDE_RUNTIME_MANIFEST_URL")
        System.clearProperty("ZCODE_IDE_RUNTIME_CHANNEL")
    }

    /** 内存键值（替代 PropertiesComponent；单测环境无 platform 运行时）。 */
    private class MemoryStore : RuntimeUpdater.PersistentStore {
        val longs = ConcurrentHashMap<String, Long>()
        val flags = ConcurrentHashMap<String, Boolean>()
        override fun readLong(key: String): Long? = longs[key]
        override fun writeLong(key: String, value: Long) {
            longs[key] = value
        }

        override fun readFlag(key: String): Boolean = flags[key] ?: false
        override fun writeFlag(key: String, value: Boolean) {
            flags[key] = value
        }
    }

    /** 注入内存 store + 临时 runtimeRoot（每个用例开头调用）。 */
    private fun installMemoryStore(): MemoryStore {
        val store = MemoryStore()
        RuntimeUpdater.store = store
        RuntimeUpdater.runtimeRoot = { root }
        return store
    }

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
            forkCommit = "cafebabe1234",
        )
    }

    /** manifest → JSON 字节（encodeDefaults 全量编码，保证签名与解析字节一致）。 */
    private fun manifestBytes(manifest: RuntimeManifest): ByteArray =
        manifestJson.encodeToString(RuntimeManifest.serializer(), manifest).toByteArray()

    companion object {
        private val manifestJson = Json { encodeDefaults = true }
    }

    // ---- Ed25519（与 RuntimeManifestSignatureTest 同模式） ----

    private fun generateKeyPair(): KeyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()

    private fun sign(privateKey: PrivateKey, data: ByteArray): String {
        val signature = Signature.getInstance("Ed25519")
        signature.initSign(privateKey)
        signature.update(data)
        return Base64.getEncoder().encodeToString(signature.sign())
    }

    private fun pemOf(keyPair: KeyPair): ByteArray {
        val base64 = Base64.getMimeEncoder(64, "\n".toByteArray()).encode(keyPair.public.encoded)
        return ("-----BEGIN PUBLIC KEY-----\n" + base64.decodeToString() + "\n-----END PUBLIC KEY-----\n").toByteArray()
    }

    /** 只接线 httpFetch：按 URL 后缀返回 [manifest] 字节与其（用 [keyPair] 生成）的签名。 */
    private fun wireRemoteBytes(manifest: RuntimeManifest, keyPair: KeyPair) {
        val bytes = manifestBytes(manifest)
        val sig = sign(keyPair.private, bytes)
        RuntimeUpdater.httpFetch = { url ->
            when {
                url.endsWith("/manifest.json") -> FetchResult.Ok(bytes)
                url.endsWith("/manifest.json.sig") -> FetchResult.Ok(sig.toByteArray())
                else -> FetchResult.Err("测试未预期的 URL：$url")
            }
        }
    }

    /**
     * 接线"合法远端"全链路：httpFetch（签名字节）+ 匹配公钥 + 本地 zip 下载 + 临时 runtimeRoot。
     * 需要观测下载是否被调用的用例，可随后覆盖 [RuntimeProvisioner.downloadImpl]。
     */
    private fun wireValidRemote(
        manifest: RuntimeManifest,
        zip: Path,
        keyPair: KeyPair = generateKeyPair(),
    ) {
        wireRemoteBytes(manifest, keyPair)
        RuntimeUpdater.publicKeyProvider = { pemOf(keyPair) }
        RuntimeProvisioner.downloadImpl = { _, _, _ -> zip }
    }

    // ---- 节流（24h；检查开始即写时间戳，失败也计） ----

    @Test
    fun `throttled within 24h skips network`() {
        val store = installMemoryStore()
        store.writeLong("zcode.ide.runtime.lastUpdateCheck", System.currentTimeMillis())
        RuntimeUpdater.httpFetch = { error("节流命中时不应发起网络") }

        val result = RuntimeUpdater.checkInBackground()

        assertEquals(Outcome.THROTTLED, result.outcome)
        assertNull(result.runtimeVersion)
    }

    @Test
    fun `force check bypasses throttle`() {
        installMemoryStore()
        RuntimeUpdater.store.writeLong("zcode.ide.runtime.lastUpdateCheck", System.currentTimeMillis())
        RuntimeUpdater.httpFetch = { FetchResult.Err("HTTP 404：stub") }

        val result = RuntimeUpdater.checkInBackground(forceCheck = true)

        // 走到了网络层（清单拉取失败），而不是被节流拦下
        assertEquals(Outcome.FAILED, result.outcome)
        assertTrue(result.message!!.contains("404"), result.message)
    }

    @Test
    fun `failed check still throttles subsequent attempts`() {
        installMemoryStore()
        RuntimeUpdater.httpFetch = { FetchResult.Err("HTTP 404：stub") }

        assertEquals(Outcome.FAILED, RuntimeUpdater.checkInBackground().outcome)
        // 失败也计（避免失败风暴）：紧接着的普通检查被 24h 节流拦下
        assertEquals(Outcome.THROTTLED, RuntimeUpdater.checkInBackground().outcome)
    }

    // ---- 开关 ----

    @Test
    fun `disabled via system property skips network and timestamp`() {
        val store = installMemoryStore()
        var fetchCalled = false
        RuntimeUpdater.httpFetch = {
            fetchCalled = true
            error("禁用时不应发起网络")
        }
        System.setProperty("ZCODE_IDE_RUNTIME_AUTO_UPDATE", "0")

        val result = RuntimeUpdater.checkInBackground()

        assertEquals(Outcome.DISABLED, result.outcome)
        assertFalse(fetchCalled)
        assertTrue(store.longs.isEmpty(), "禁用时不应写节流时间戳")
    }

    // ---- 验签失败：回退 baseline（UP_TO_DATE），最多提示一次 ----

    @Test
    fun `signature failure falls back to up-to-date and flags once`() {
        val store = installMemoryStore()
        val (zip, manifest) = buildRuntimeZip("0.2.0+cafebabe1234")
        // 测试私钥自签；公钥保持默认（插件内置 runtime-signing-public.pem）→ 必然验签失败
        wireRemoteBytes(manifest, generateKeyPair())
        var downloadCalled = false
        RuntimeProvisioner.downloadImpl = { _, _, _ ->
            downloadCalled = true
            zip
        }

        val first = RuntimeUpdater.checkInBackground()

        assertEquals(Outcome.UP_TO_DATE, first.outcome)
        assertTrue(store.flags["zcode.ide.runtime.sigFailNotified"] == true, "首次失败应置提示标记")
        assertFalse(downloadCalled)

        // 第二次（force 跳过节流）：仍 UP_TO_DATE（静默），同样不下载
        val second = RuntimeUpdater.checkInBackground(forceCheck = true)
        assertEquals(Outcome.UP_TO_DATE, second.outcome)
        assertFalse(downloadCalled)
    }

    // ---- 兼容与判新 ----

    @Test
    fun `incompatible manifest is rejected before download`() {
        installMemoryStore()
        val (zip, manifest) = buildRuntimeZip("0.2.0+cafebabe1234")
        wireValidRemote(manifest.copy(runtimeApiVersion = RuntimeManifest.RUNTIME_API_VERSION + 999), zip)
        var downloadCalled = false
        RuntimeProvisioner.downloadImpl = { _, _, _ ->
            downloadCalled = true
            zip
        }

        val result = RuntimeUpdater.checkInBackground()

        assertEquals(Outcome.INCOMPATIBLE, result.outcome)
        assertEquals("0.2.0+cafebabe1234", result.runtimeVersion)
        assertFalse(downloadCalled)
    }

    @Test
    fun `up-to-date when current is not older than remote`() {
        installMemoryStore()
        // 本地 current.json 指向更高的版本号
        RuntimeProvisioner.writeCurrentPointer(
            root,
            RuntimeProvisioner.Pointer("9.9.9+aaaaaaaaaaaa", "9.9.9-aaaaaaaaaaaa", "f".repeat(64), "2026-10-25T00:00:00Z"),
        )
        val (zip, manifest) = buildRuntimeZip("0.2.0+cafebabe1234")
        wireValidRemote(manifest, zip)
        var downloadCalled = false
        RuntimeProvisioner.downloadImpl = { _, _, _ ->
            downloadCalled = true
            zip
        }

        val result = RuntimeUpdater.checkInBackground()

        assertEquals(Outcome.UP_TO_DATE, result.outcome)
        assertEquals("0.2.0+cafebabe1234", result.runtimeVersion)
        assertFalse(downloadCalled)
    }

    // ---- DOWNLOADED：完整落地 + pending.json，且不写 current.json ----

    @Test
    fun `downloaded writes pending and version dir but not current`() {
        installMemoryStore()
        val (zip, manifest) = buildRuntimeZip("0.2.0+cafebabe1234")
        wireValidRemote(manifest, zip)
        val downloads = mutableListOf<RuntimeManifest>()
        RuntimeProvisioner.downloadImpl = { _, m, _ ->
            downloads += m
            zip
        }

        val result = RuntimeUpdater.checkInBackground()

        assertEquals(Outcome.DOWNLOADED, result.outcome)
        assertEquals("0.2.0+cafebabe1234", result.runtimeVersion)
        assertEquals(listOf(manifest), downloads)

        // 版本目录落地（真实校验/解压执行：必需文件 + .complete.json）
        val target = root.resolve("0.2.0-cafebabe1234")
        assertTrue(Files.isDirectory(target))
        assertTrue(Files.isRegularFile(target.resolve("server/entry-http.js")))
        assertTrue(Files.isRegularFile(target.resolve("web/index.html")))
        assertTrue(Files.isRegularFile(target.resolve(".complete.json")))

        // pending.json 写入且字段齐全
        val pending = Json.parseToJsonElement(Files.readString(root.resolve("pending.json"))).jsonObject
        assertEquals("0.2.0+cafebabe1234", pending["version"]!!.jsonPrimitive.content)
        assertEquals("0.2.0-cafebabe1234", pending["path"]!!.jsonPrimitive.content)
        assertEquals(manifest.sha256, pending["sha256"]!!.jsonPrimitive.content)
        assertTrue(pending["installedAt"]!!.jsonPrimitive.content.isNotBlank())

        // current.json 未写（promote 由启动逻辑做）
        assertFalse(Files.exists(root.resolve("current.json")))
        // 通知在无 Application 的单测环境被跳过：执行到这里即未抛异常
    }

    @Test
    fun `notify fires only for downloaded`() {
        installMemoryStore()
        val (zip, manifest) = buildRuntimeZip("0.2.0+cafebabe1234")
        wireValidRemote(manifest, zip)
        val notified = mutableListOf<Outcome>()
        RuntimeUpdater.notifyFn = { result, _ -> notified += result.outcome }

        assertEquals(Outcome.DOWNLOADED, RuntimeUpdater.checkInBackground().outcome)
        // 第二次被 24h 节流：不发通知
        assertEquals(Outcome.THROTTLED, RuntimeUpdater.checkInBackground().outcome)
        assertEquals(listOf(Outcome.DOWNLOADED), notified)
    }

    // ---- 拉远端失败形态 ----

    @Test
    fun `unparseable manifest fails with reason`() {
        installMemoryStore()
        // manifest 与 sig 都拉取成功后才解析：sig 内容无所谓（解析在验签之前）
        RuntimeUpdater.httpFetch = { url ->
            when {
                url.endsWith("/manifest.json.sig") -> FetchResult.Ok("AAAA".toByteArray())
                else -> FetchResult.Ok("not json".toByteArray())
            }
        }

        val result = RuntimeUpdater.checkInBackground()

        assertEquals(Outcome.FAILED, result.outcome)
        assertTrue(result.message!!.contains("解析"), result.message)
    }

    @Test
    fun `sig fetch failure fails the check with reason`() {
        installMemoryStore()
        val (_, manifest) = buildRuntimeZip("0.2.0+cafebabe1234")
        val bytes = manifestBytes(manifest)
        RuntimeUpdater.httpFetch = { url ->
            when {
                url.endsWith("/manifest.json") -> FetchResult.Ok(bytes)
                else -> FetchResult.Err("HTTP 404：$url")
            }
        }

        val result = RuntimeUpdater.checkInBackground()

        assertEquals(Outcome.FAILED, result.outcome)
        assertTrue(result.message!!.contains("签名"), result.message)
    }

    @Test
    fun `default fetch rejects non-https url without network`() {
        val result = RuntimeUpdater.fetchRemote("http://cdn.example.com/zcode-ide/runtime/stable/manifest.json")

        assertTrue(result is FetchResult.Err)
        assertTrue((result as FetchResult.Err).reason.contains("HTTPS"), result.reason)
    }

    @Test
    fun `fetchRemote passes http scheme check when debug switch is on`() {
        System.setProperty(RuntimeSettings.KEY_ALLOW_HTTP, "1")
        try {
            // 127.0.0.1:1 会立即连接失败：用于证明失败原因是网络而非「非 HTTPS」拦截。
            val result = RuntimeUpdater.fetchRemote("http://127.0.0.1:1/zcode-ide/manifest.json")
            assertTrue(result is FetchResult.Err)
            assertFalse((result as FetchResult.Err).reason.contains("非 HTTPS"), result.reason)
        } finally {
            System.clearProperty(RuntimeSettings.KEY_ALLOW_HTTP)
        }
    }

    // ---- 并发防御：检查进行中再入直接 THROTTLED ----

    @Test
    @Timeout(15)
    fun `concurrent re-entry is throttled while a check is in flight`() {
        installMemoryStore()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val fetchCalls = AtomicInteger()
        RuntimeUpdater.httpFetch = { url ->
            fetchCalls.incrementAndGet()
            entered.countDown()
            release.await(10, TimeUnit.SECONDS)
            FetchResult.Err("HTTP 500：$url")
        }

        val executor = Executors.newSingleThreadExecutor()
        try {
            val inFlight = executor.submit(Callable { RuntimeUpdater.checkInBackground() })
            assertTrue(entered.await(10, TimeUnit.SECONDS), "第一个检查应进入网络拉取")

            // 第一个检查未结束时，再次检查直接 THROTTLED，且不发网络
            val reentry = RuntimeUpdater.checkInBackground()
            assertEquals(Outcome.THROTTLED, reentry.outcome)

            release.countDown()
            val first = inFlight.get(10, TimeUnit.SECONDS)
            assertEquals(Outcome.FAILED, first.outcome)
            assertEquals(1, fetchCalls.get(), "重入不应追加网络请求")
        } finally {
            release.countDown()
            executor.shutdownNow()
        }
    }
}
