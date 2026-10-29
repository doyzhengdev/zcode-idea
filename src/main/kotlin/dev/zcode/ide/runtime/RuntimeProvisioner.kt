package dev.zcode.ide.runtime

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.zip.ZipFile

/** Runtime 供给失败。文案面向用户（中文、含原因），cause 保留原始异常。 */
class RuntimeProvisionException(message: String, cause: Throwable? = null) : IllegalStateException(message, cause)

/**
 * ZCode 运行时（zcode-runtime.zip）的下载落地器：
 *
 * 1. [RuntimeLayout.resolve] 命中（系统属性/env、开发期 vendor/ZCode、插件自带完整包）→ 直接用；
 * 2. 用户目录 `<dataRoot>/ide/runtime/current.json` 有效 → 用已下载的版本（不重算 sha256）；
 * 3. 都没有 → 按内置 baseline manifest 下载、校验、解压、原子落到 `<versionDir>/`，
 *    写 current.json 后返回可直接喂给 [ServerProcess] 的 [RuntimeLayout]。
 *
 * 目录布局（方案 §6.4）：
 * ```text
 * <dataRoot>/ide/runtime/     # dataRoot = env ZCODE_DATA_BASE_DIR ?: ~/.zcode
 * ├── .lock                   # FileChannel.lock，多 IDE 进程只允许一个下载
 * ├── current.json / pending.json
 * ├── <versionDir>/           # 解压后的 runtime（打包布局），内含 .complete.json
 * └── <versionDir>.part       # 下载中断的续传文件
 * ```
 *
 * ZCodeServerManager 启动时序接入本对象（pending 优先 → ensure → NodeProvisioner）；公开 API 是冻结契约，不得改名改签名。
 * 调试用环境变量：`ZCODE_DATA_BASE_DIR`（覆盖数据根）、`ZCODE_IDE_RUNTIME_BASE_URL`（覆盖下载源）。
 */
object RuntimeProvisioner {
    // 单元测试环境没有 IntelliJ platform 运行时，Logger 初始化可能失败；lazy + runCatching 兜底。
    private val log: Logger? by lazy { runCatching { Logger.getInstance("ZCodeIDE") }.getOrNull() }

    private const val DEFAULT_BASE_URL = "https://cdn.example.com/"
    private const val BASE_URL_PROPERTY = RuntimeSettings.KEY_BASE_URL
    private const val BASE_URL_ENV = RuntimeSettings.ENV_BASE_URL

    private const val POINTER_FILE = "current.json"
    private const val PENDING_FILE = "pending.json"
    private const val COMPLETE_FILE = ".complete.json"
    private const val LOCK_FILE = ".lock"

    private const val LOCK_WAIT_TIMEOUT_MS = 30L * 60 * 1000
    private const val LOCK_POLL_INTERVAL_MS = 2_000L
    private const val DOWNLOAD_REPORT_STEP = 2L * 1024 * 1024
    private const val DOWNLOAD_REPORT_INTERVAL_MS = 500L
    private const val DOWNLOAD_BUFFER_SIZE = 128 * 1024
    private const val PART_MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000

    /** 读停滞看门狗阈值：60s 无新字节视为远端停滞（「读超时 60s」的落地）。 */
    private const val READ_STALL_TIMEOUT_MS = 60_000L

    /** 看门狗巡检周期：不超过阈值本身，长阈值时取 1s。 */
    private const val WATCHDOG_POLL_INTERVAL_MS = 1_000L

    private val http: HttpClient = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NORMAL)
        .connectTimeout(Duration.ofSeconds(20))
        .build()

    /** 下载停滞看门狗线程（daemon，随 JVM 退出，无需显式关闭）。 */
    private val watchdogExecutor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "ZCode-RuntimeDownloadWatchdog").apply { isDaemon = true }
    }

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    /** current.json / pending.json 的结构（方案 §6.4）；`path` 是版本目录名。 */
    @Serializable
    internal data class Pointer(
        val version: String,
        val path: String,
        val sha256: String = "",
        val installedAt: String = "",
    )

    /** `<versionDir>/.complete.json` 的结构：目录"已完整安装"的凭证。 */
    @Serializable
    internal data class CompleteInfo(
        val version: String,
        val sha256: String = "",
        val size: Long = 0,
        val installedAt: String = "",
    )

    // ---- 公开 API（冻结契约） ----

    /**
     * 确保有可用的 ZCode 运行时，可能触发一次几十 MB 的下载，**必须在后台线程调用**（无需自己切线程）。
     * [status] 用于把进度回显到面板（调用方负责切回 EDT）。
     */
    fun ensure(status: (String) -> Unit = {}): RuntimeLayout {
        // 决策 1：系统属性/env、开发期 vendor/ZCode、插件自带完整包、用户目录下载版优先，覆盖一切下载逻辑。
        RuntimeLayout.resolve()?.let {
            status("使用现有 ZCode 运行时：${it.root}")
            return it
        }
        return ensureAt(defaultRoot(), RuntimeManifest.loadBaseline(), status)
    }

    /** 用户目录 current.json 里记录的版本；指针无效返回 null。 */
    fun currentVersion(): String? = currentVersionAt(defaultRoot())

    /** baseline manifest 便捷访问。 */
    fun baselineManifest(): RuntimeManifest? = RuntimeManifest.loadBaseline()

    /**
     * 清理旧版本与过期 .part：删除既不属于 current、pending，也不是「current 上一版」的版本目录
     * （缺失 [.complete.json] 的垃圾目录一并删除）；删除 mtime 超 7 天的 `.part`。
     * 指针缺失时对应 keep 参数语义自然退化（无从保留则按其他参数清理）。
     */
    fun cleanup(keepCurrent: Boolean = true, keepPending: Boolean = true, keepPreviousOne: Boolean = true) {
        cleanupAt(defaultRoot(), keepCurrent, keepPending, keepPreviousOne)
    }

    // ---- 决策链（root 可注入，供测试） ----

    /**
     * [ensure] 的用户目录分支（决策 2/3）。[baseline] 为 null 时抛错并给出离线出路；
     * [download] 是下载实现（默认网络下载），测试可注入本地 zip。
     */
    internal fun ensureAt(
        root: Path,
        baseline: RuntimeManifest?,
        status: (String) -> Unit = {},
        download: (Path, RuntimeManifest, (String) -> Unit) -> Path = ::downloadWithResume,
    ): RuntimeLayout {
        validCurrentLayout(root)?.let {
            status("使用已下载的 ZCode 运行时（${it.root.fileName}）")
            return it
        }
        val manifest = baseline ?: throw RuntimeProvisionException(
            "没有可用的 ZCode 运行时，且插件内置清单缺失。" +
                "离线环境可设置环境变量 ZCODE_IDE_RUNTIME 指向本地运行时目录，" +
                "或安装带完整运行时的插件包（构建参数 -PbundleRuntime=true）。",
        )
        return downloadAndInstall(root, manifest, status, download = download)
    }

    /** 用户目录指针里记录的版本；指针无效返回 null。 */
    internal fun currentVersionAt(root: Path): String? =
        readPointer(root.resolve(POINTER_FILE))?.version?.takeIf(String::isNotBlank)

    /**
     * 下载实现（默认网络下载）；[installVersion] 的更新链路共用此入口。
     * 单测可整体替换为本地 zip，让 RuntimeUpdater 的 DOWNLOADED 用例不起真网络。
     */
    @Volatile
    internal var downloadImpl: (Path, RuntimeManifest, (String) -> Unit) -> Path = ::downloadWithResume

    /**
     * 下载 + 安装（含文件锁与磁盘检查）。[download] 可注入（测试用本地 zip 替代网络）。
     * [writeCurrent] = false 时不写 current.json（[installVersion] 的更新链路用：版本目录落地后
     * 由 RuntimeUpdater 写 pending.json，promote 交给启动逻辑）。
     * 失败时：staging 必定清理；.part 保留供续传（校验失败除外——见 [installFromArchive]）。
     */
    internal fun downloadAndInstall(
        root: Path,
        manifest: RuntimeManifest,
        status: (String) -> Unit,
        writeCurrent: Boolean = true,
        download: (Path, RuntimeManifest, (String) -> Unit) -> Path = ::downloadWithResume,
    ): RuntimeLayout {
        if (!manifest.isCompatible(RuntimeManifest.PLUGIN_VERSION)) {
            throw RuntimeProvisionException(
                "内置运行时清单（${manifest.runtimeVersion}）与当前插件 ${RuntimeManifest.PLUGIN_VERSION} 不兼容，已跳过下载。",
            )
        }
        Files.createDirectories(root)

        // 进入下载前：同版本目录已完整（如解压成功但指针没写）→ 直接认领，不再下载。
        adoptIfComplete(root, manifest, status, writeCurrent)?.let { return it }

        checkDiskSpace(root, manifest)

        val channel = FileChannel.open(
            root.resolve(LOCK_FILE),
            StandardOpenOption.CREATE,
            StandardOpenOption.READ,
            StandardOpenOption.WRITE,
        )
        var lock: FileLock? = null
        try {
            // 多个 IDE 进程只允许一个下载；其余轮询等待 current 就绪（方案 §6.4）。
            val deadline = System.currentTimeMillis() + LOCK_WAIT_TIMEOUT_MS
            while (true) {
                lock = try {
                    channel.tryLock()
                } catch (_: OverlappingFileLockException) {
                    // 同一 JVM 内已有持有者（同进程第二个调用者）会抛 OverlappingFileLockException
                    // 而不是返回 null：与跨进程锁被占同等处理，进入等待轮询，
                    // 直到对方装完（current 就绪）或锁释放。
                    null
                }
                if (lock != null) break
                validCurrentLayout(root)?.let { return it }
                if (System.currentTimeMillis() > deadline) {
                    throw RuntimeProvisionException("等待其他 ZCode 进程完成运行时下载超时（30 分钟），请重试。")
                }
                status("另一个 ZCode 进程正在下载运行时，等待中…")
                try {
                    Thread.sleep(LOCK_POLL_INTERVAL_MS)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw RuntimeProvisionException("等待其他 ZCode 进程完成运行时下载时被中断", e)
                }
            }

            // 拿到锁后再确认一次：等待期间另一进程可能刚装完。
            validCurrentLayout(root)?.let { return it }
            adoptIfComplete(root, manifest, status, writeCurrent)?.let { return it }

            val archive = download(root, manifest, status)
            return installFromArchive(root, manifest, archive, writeCurrent, status)
        } finally {
            runCatching { lock?.release() }
            runCatching { channel.close() }
        }
    }

    /**
     * 下载并安装 [manifest] 指定的版本到 `<root>/<versionDir>`（含 `.complete.json`），
     * 但**不写 current.json**——RuntimeUpdater（更新检查）用：版本目录落地后由调用方写
     * pending.json，promote 交给启动逻辑（方案 §6.3）。复用 [downloadAndInstall] 的
     * 下载/校验/解压/原子落盘/锁逻辑，仅跳过写 current；公开 API 与既有行为不变。
     * [root] 与 [download] 可注入（单测不起真网络、不碰真实用户目录）。
     * 必须在后台线程调用。返回版本目录。
     */
    internal fun installVersion(
        manifest: RuntimeManifest,
        status: (String) -> Unit = {},
        root: Path = defaultRoot(),
        download: (Path, RuntimeManifest, (String) -> Unit) -> Path = downloadImpl,
    ): Path {
        downloadAndInstall(root, manifest, status, writeCurrent = false, download = download)
        return root.resolve(manifest.versionDir)
    }

    /** 清理分支（root 可注入，供测试）。 */
    internal fun cleanupAt(
        root: Path,
        keepCurrent: Boolean,
        keepPending: Boolean,
        keepPreviousOne: Boolean,
    ) {
        if (!Files.isDirectory(root)) return
        val current = readPointer(root.resolve(POINTER_FILE))
        val pending = readPointer(root.resolve(PENDING_FILE))

        val keep = mutableSetOf<String>()
        if (keepCurrent) current?.path?.takeIf(String::isNotBlank)?.let { keep += it }
        if (keepPending) pending?.path?.takeIf(String::isNotBlank)?.let { keep += it }

        val dirs = Files.list(root).use { stream -> stream.filter(Files::isDirectory).toList() }

        // 「current 的上一版」：比 current 旧的完整版本目录里最新的一个，保留用于回滚（方案 §6.4）。
        if (keepPreviousOne) {
            val currentSemVer = current?.version?.let { SemVer.parse(it.substringBefore('+')) }
            if (currentSemVer != null) {
                dirs.asSequence()
                    .map { it.fileName.toString() }
                    .filter { it !in keep }
                    .mapNotNull { name -> SemVer.parse(name.substringBefore('-'))?.let { name to it } }
                    .filter { (_, semVer) -> semVer < currentSemVer }
                    .filter { (name, _) -> Files.isRegularFile(root.resolve(name).resolve(COMPLETE_FILE)) }
                    .maxByOrNull { (_, semVer) -> semVer }
                    ?.let { (name, _) -> keep += name }
            }
        }

        // keep 集合内的目录无条件保留（可能正被运行中的 server 使用）；其余一律删除。
        for (dir in dirs) {
            if (dir.fileName.toString() in keep) continue
            deleteRecursively(dir)
        }

        // 过期 .part：mtime 超 7 天（短期中断保留续传能力）。
        Files.list(root).use { stream ->
            stream.filter(Files::isRegularFile)
                .filter { it.fileName.toString().endsWith(".part") }
                .forEach { part ->
                    val age = runCatching {
                        System.currentTimeMillis() - Files.getLastModifiedTime(part).toMillis()
                    }.getOrDefault(Long.MAX_VALUE)
                    if (age > PART_MAX_AGE_MS) runCatching { Files.deleteIfExists(part) }
                }
        }
    }

    // ---- 校验、解压、落盘 ----

    /**
     * 从已有压缩包安装（校验 → 解压 → 原子落盘 → 写指针），**不起网络**，测试可直接调用。
     * [archive] 通常是 `<versionDir>.part`：校验失败时删除它（防坏缓存）；安装成功后也删除。
     * [writeCurrent] = false 时跳过写 current.json（[installVersion] 的更新链路用）。
     */
    internal fun installFromArchive(
        root: Path,
        manifest: RuntimeManifest,
        archive: Path,
        writeCurrent: Boolean = true,
        status: (String) -> Unit = {},
    ): RuntimeLayout {
        Files.createDirectories(root)

        // 同版本目录已完整（解压成功但指针没写、或另一进程刚装完）→ 不重复解压，直接认领。
        adoptIfComplete(root, manifest, status, writeCurrent)?.let { return it }

        // 完整性校验（解压前，方案 §6.2）：sha256 + size。
        status("正在校验 ZCode 运行时…")
        val actualSha = sha256(archive)
        val actualSize = Files.size(archive)
        if (actualSize != manifest.size || !actualSha.equals(manifest.sha256, ignoreCase = true)) {
            runCatching { Files.deleteIfExists(archive) }
            throw RuntimeProvisionException(
                "运行时下载校验失败：期望 ${manifest.size} 字节 / sha256=${manifest.sha256}，" +
                    "实际 $actualSize 字节 / sha256=$actualSha",
            )
        }

        val target = root.resolve(manifest.versionDir)
        val staging = root.resolve("${manifest.versionDir}.staging-${UUID.randomUUID()}")
        try {
            status("正在解压 ZCode 运行时…")
            extractZip(archive, staging)
            verifyRequiredFiles(staging)
            applyPosixPermissions(staging)
            writeCompleteInfo(staging, manifest)

            // 原子落盘到版本目录（方案 §6.4）。
            if (Files.exists(target)) {
                if (isCompleteDirectory(target, manifest)) {
                    // 理论不可达（函数开头已 adoptIfComplete）：丢弃 staging，复用现成目录。
                    deleteRecursively(staging)
                } else {
                    // 半成品目录（中断/垃圾）：删除后重放。
                    deleteRecursively(target)
                    atomicMove(staging, target)
                }
            } else {
                atomicMove(staging, target)
            }
        } finally {
            // staging 已被 move 走时此调用为 no-op；任何步骤抛错都保证清理。
            deleteRecursively(staging)
        }

        // 安装成功：本次下载的 .part 已无用，删除。
        runCatching { Files.deleteIfExists(root.resolve("${manifest.versionDir}.part")) }

        if (writeCurrent) writeCurrentPointer(root, manifest)
        log?.info("Provisioned ZCode runtime ${manifest.runtimeVersion} at $target")
        return buildLayout(target, manifest.runtimeVersion)
    }

    // ---- 指针（Task D 的 RuntimeUpdater 也会用） ----

    /** 读 current.json；缺失或损坏返回 null。 */
    internal fun readCurrentPointer(root: Path): Pointer? = readPointer(root.resolve(POINTER_FILE))

    /** 读 pending.json；缺失或损坏返回 null。 */
    internal fun readPendingPointer(root: Path): Pointer? = readPointer(root.resolve(PENDING_FILE))

    /** current.json 原子落盘（临时文件 + ATOMIC_MOVE）。 */
    internal fun writeCurrentPointer(root: Path, pointer: Pointer) {
        atomicWriteJson(root.resolve(POINTER_FILE), json.encodeToString(Pointer.serializer(), pointer))
    }

    /** pending.json 原子落盘（本任务不产生 pending，函数供 Task D 使用）。 */
    internal fun writePendingPointer(root: Path, pointer: Pointer) {
        atomicWriteJson(root.resolve(PENDING_FILE), json.encodeToString(Pointer.serializer(), pointer))
    }

    /**
     * pending.json 是否指向一个可启动的运行时更新（方案 §6.3 启动侧）：
     * 指针可解析、`version`/`path` 非空、`path` 是安全的目录名（防越出 runtime 根）、
     * 版本目录存在且含 `.complete.json`。无效返回 null。
     */
    internal fun validPendingPointer(root: Path): Pointer? {
        val pointer = readPointer(root.resolve(PENDING_FILE)) ?: return null
        if (pointer.version.isBlank() || pointer.path.isBlank()) return null
        if (pointer.path == "." || pointer.path == ".." ||
            pointer.path.contains('/') || pointer.path.contains('\\')
        ) {
            return null
        }
        val dir = root.resolve(pointer.path)
        if (!Files.isDirectory(dir)) return null
        if (!Files.isRegularFile(dir.resolve(COMPLETE_FILE))) return null
        return pointer
    }

    /**
     * promote（方案 §6.3）：current.json ← pending 内容（原子写），删除 pending.json。
     * 版本目录不动（原 current 版本目录由随后的 [cleanup] 按 keep 参数处理）。返回是否成功。
     */
    internal fun promotePendingPointer(root: Path, pending: Pointer): Boolean = try {
        writeCurrentPointer(root, pending)
        Files.deleteIfExists(root.resolve(PENDING_FILE))
        true
    } catch (e: Exception) {
        log?.warn("Failed to promote pending runtime pointer", e)
        false
    }

    /**
     * rollback（方案 §6.3）：删除 pending.json；版本目录保留供排查（由后续 cleanup/下次下载兜底）。
     * 返回 pending.json 是否已不存在（删除成功或本来就缺失都算 true）。
     */
    internal fun rollbackPendingPointer(root: Path): Boolean = try {
        Files.deleteIfExists(root.resolve(PENDING_FILE))
        true
    } catch (e: Exception) {
        log?.warn("Failed to remove pending runtime pointer", e)
        false
    }

    private fun writeCurrentPointer(root: Path, manifest: RuntimeManifest) =
        writeCurrentPointer(
            root,
            Pointer(
                version = manifest.runtimeVersion,
                path = manifest.versionDir,
                sha256 = manifest.sha256,
                installedAt = nowIso(),
            ),
        )

    private fun readPointer(file: Path): Pointer? = runCatching {
        json.decodeFromString(Pointer.serializer(), Files.readString(file))
    }.getOrNull()

    /** 指针原子落盘：写临时文件后 ATOMIC_MOVE，失败退化为替换写（方案 §6.4）。 */
    private fun atomicWriteJson(file: Path, content: String) {
        val temp = file.resolveSibling("${file.fileName}.tmp-${UUID.randomUUID()}")
        try {
            Files.writeString(temp, content)
            try {
                Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            runCatching { Files.deleteIfExists(temp) }
        }
    }

    // ---- 下载 ----

    /**
     * 下载到 `<versionDir>.part`，支持 Range 续传：.part 已存在时请求 `Range: bytes=<已有字节数>-`，
     * 206 追加写、200 从头重下、416 视为 .part 已完整（直接交给后续校验）。
     * .part 每次写入都落盘保留，进程中断后可续传。
     */
    private fun downloadWithResume(root: Path, manifest: RuntimeManifest, status: (String) -> Unit): Path {
        val url = downloadUrl(manifest)
        val partFile = root.resolve("${manifest.versionDir}.part")
        try {
            var offset = if (Files.exists(partFile)) Files.size(partFile) else 0L
            val builder = HttpRequest.newBuilder(URI.create(url))
                // 60s 只约束到"收到响应"为止（连接/响应头）；body 流读取无总时长限制，
                // 由 [readDownloadBody] 的停滞看门狗保护（60s 无新字节即中止，详见其 KDoc）。
                .timeout(Duration.ofSeconds(60))
                .GET()
            if (offset > 0) builder.header("Range", "bytes=$offset-")

            val response = http.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream())
            val code = response.statusCode()
            when {
                code == 206 -> Unit // 续传：在已有字节数之后追加。
                code == 200 -> offset = 0L // 服务器不支持 Range：从头重下。
                code == 416 -> response.body().close() // .part 已达全长（上次下完但未校验）。
                else -> {
                    response.body().close()
                    throw RuntimeProvisionException("下载 ZCode 运行时失败（HTTP $code）：$url")
                }
            }
            if (code == 416) return partFile

            val headerLength = response.headers().firstValueAsLong("content-length").orElse(-1L)
            val total = when {
                headerLength <= 0 -> -1L
                code == 206 -> offset + headerLength
                else -> headerLength
            }
            status("正在下载 ZCode 运行时…")
            response.body().use { input ->
                readDownloadBody(partFile, input, append = code == 206, total = total, status = status)
            }
            return partFile
        } catch (e: RuntimeProvisionException) {
            throw e
        } catch (e: IOException) {
            throw RuntimeProvisionException("下载 ZCode 运行时失败：${e.message ?: e::class.java.simpleName}", e)
        }
    }

    /**
     * 下载 body 读取循环 + 停滞看门狗（「读超时 60s」的落地，下载无总时长限制）。
     *
     * 每收到新字节刷新计时；监控线程发现 [stallTimeoutMs] 内无新字节时强制关流，
     * 令阻塞中的 `read` 立刻失败，转为「下载停滞超时」错误——避免远端停滞时 ensure
     * 永久挂起且全程持有 `.lock`（其他 IDE 进程会被拖满 30 分钟等待超时）。
     * 停滞按下载失败语义处理：已写入 .part 的字节保留，重试时从断点续传。
     *
     * [stallTimeoutMs] 可注入（测试缩短阈值）；默认 60s（[READ_STALL_TIMEOUT_MS]）。
     */
    internal fun readDownloadBody(
        partFile: Path,
        input: InputStream,
        append: Boolean,
        total: Long,
        status: (String) -> Unit,
        stallTimeoutMs: Long = READ_STALL_TIMEOUT_MS,
    ) {
        var written = if (append && Files.exists(partFile)) Files.size(partFile) else 0L
        val lastDataNanos = AtomicLong(System.nanoTime())
        val stalled = AtomicBoolean(false)
        val watchdog = watchdogExecutor.scheduleWithFixedDelay(
            {
                if (System.nanoTime() - lastDataNanos.get() > stallTimeoutMs * 1_000_000 &&
                    stalled.compareAndSet(false, true)
                ) {
                    // 关流使阻塞中的 read 立刻抛 IOException（真实响应流会连带关闭底层 socket）。
                    runCatching { input.close() }
                }
            },
            stallTimeoutMs,
            minOf(stallTimeoutMs, WATCHDOG_POLL_INTERVAL_MS),
            TimeUnit.MILLISECONDS,
        )
        try {
            Files.newOutputStream(
                partFile,
                StandardOpenOption.CREATE,
                StandardOpenOption.WRITE,
                if (append) StandardOpenOption.APPEND else StandardOpenOption.TRUNCATE_EXISTING,
            ).use { output ->
                val buffer = ByteArray(DOWNLOAD_BUFFER_SIZE)
                var lastReportBytes = written
                var lastReportTime = System.currentTimeMillis()
                while (true) {
                    val read = try {
                        input.read(buffer)
                    } catch (e: IOException) {
                        if (stalled.get()) {
                            throw RuntimeProvisionException(
                                "下载 ZCode 运行时停滞超时（${stallTimeoutMs / 1000} 秒无新数据），已中止下载；" +
                                    "已下载部分已保留，重试时将从断点继续。",
                                e,
                            )
                        }
                        throw e
                    }
                    if (read < 0) break
                    output.write(buffer, 0, read)
                    written += read
                    lastDataNanos.set(System.nanoTime())
                    val now = System.currentTimeMillis()
                    if (total > 0 &&
                        (
                            written - lastReportBytes >= DOWNLOAD_REPORT_STEP ||
                                now - lastReportTime >= DOWNLOAD_REPORT_INTERVAL_MS
                            )
                    ) {
                        lastReportBytes = written
                        lastReportTime = now
                        status("正在下载 ZCode 运行时 ${mb(written)} / ${mb(total)} MB…")
                    }
                }
            }
        } finally {
            watchdog.cancel(false)
        }
    }

    /** 下载地址 = base URL + archivePath；只允许 HTTPS（方案 §8.3），http 仅显式调试开关放行。 */
    private fun downloadUrl(manifest: RuntimeManifest): String {
        val url = baseUrl().trimEnd('/') + "/" + manifest.archivePath.trimStart('/')
        if (!RuntimeSettings.isAllowedSourceUrl(url)) {
            throw RuntimeProvisionException(
                "运行时下载地址必须是 HTTPS（本地联调可设 ZCODE_IDE_RUNTIME_ALLOW_HTTP=1），拒绝下载：$url",
            )
        }
        if (!url.startsWith("https://")) RuntimeSettings.warnInsecureOnce(url)
        return url
    }

    /**
     * base URL（方案 §6.7 优先级链）：系统属性 `zcode.ide.runtime.baseUrl` >
     * env `ZCODE_IDE_RUNTIME_BASE_URL` > 设置页（[RuntimeSettings.KEY_BASE_URL]）> 默认占位域名；
     * 末尾斜杠归一化。internal 供覆盖链单测。
     */
    internal fun baseUrl(): String =
        (RuntimeSettings.settingValue(BASE_URL_PROPERTY, BASE_URL_ENV) ?: DEFAULT_BASE_URL)
            .trimEnd('/') + "/"

    // ---- 有效性、认领与校验 ----

    /**
     * 用户目录 current.json 指向的运行时是否可用；可用则直接构造 [RuntimeLayout]。
     * 「有效」= 指针可解析、`path` 目录存在、`server/entry-http.js` 与 `web/index.html` 存在、
     * `.complete.json` 存在。使用时不重算 sha256（184MB 重算不可接受，完整性由安装时保证）。
     */
    private fun validCurrentLayout(root: Path): RuntimeLayout? {
        val pointer = readPointer(root.resolve(POINTER_FILE)) ?: return null
        val dir = root.resolve(pointer.path)
        if (!Files.isDirectory(dir)) return null
        if (!Files.isRegularFile(dir.resolve("server/entry-http.js"))) return null
        if (!Files.isRegularFile(dir.resolve("web/index.html"))) return null
        if (!Files.isRegularFile(dir.resolve(COMPLETE_FILE))) return null
        return buildLayout(dir, pointer.version)
    }

    /**
     * 同版本目录已完整（存在且 `.complete.json` 合法）→ 认领并返回 layout；否则 null。
     * 对应「下载中断后重试」与「解压成功但指针没写」的恢复路径。
     * [writeCurrent] = false 时不写 current.json（更新链路：是否启用由 pending 侧决定）。
     */
    private fun adoptIfComplete(
        root: Path,
        manifest: RuntimeManifest,
        status: (String) -> Unit,
        writeCurrent: Boolean = true,
    ): RuntimeLayout? {
        val target = root.resolve(manifest.versionDir)
        if (!isCompleteDirectory(target, manifest)) return null
        status("ZCode 运行时 ${manifest.runtimeVersion} 已就绪，跳过下载")
        runCatching { Files.deleteIfExists(root.resolve("${manifest.versionDir}.part")) }
        if (writeCurrent) writeCurrentPointer(root, manifest)
        return buildLayout(target, manifest.runtimeVersion)
    }

    /** 目录是否为该 manifest 的完整安装：`.complete.json` 可解析且 version/sha256 与 manifest 一致。 */
    private fun isCompleteDirectory(dir: Path, manifest: RuntimeManifest): Boolean {
        if (!Files.isDirectory(dir)) return false
        val info = runCatching {
            json.decodeFromString(CompleteInfo.serializer(), Files.readString(dir.resolve(COMPLETE_FILE)))
        }.getOrNull() ?: return false
        return info.version == manifest.runtimeVersion && info.sha256 == manifest.sha256
    }

    /** 磁盘空间检查：剩余 < (size + max(uncompressedSize, 0)) × 1.1 → 抛错（方案 §6.2）。 */
    private fun checkDiskSpace(root: Path, manifest: RuntimeManifest) {
        val required = (manifest.size + maxOf(manifest.uncompressedSize, 0L)) * 1.1
        // getFileStore 失败时保守放行，不因探测问题阻塞安装。
        val usable = runCatching { Files.getFileStore(root).usableSpace }.getOrDefault(Long.MAX_VALUE)
        if (usable < required) {
            throw RuntimeProvisionException(
                "磁盘空间不足：安装 ZCode 运行时需要约 ${mb(required.toLong())} MB，" +
                    "目标分区仅剩 ${mb(usable)} MB。请清理磁盘后重试。",
            )
        }
    }

    /**
     * 版本目录 → 打包布局（server/ web/ agent/ remote-bridge/，与 package-runtime.mjs 的 zip 根一致）。
     * [runtimeVersion] 由调用方按指针/manifest 提供（方案 §6.5 的复用判定需要）。
     */
    internal fun buildLayout(dir: Path, runtimeVersion: String? = null): RuntimeLayout = RuntimeLayout(
        root = dir,
        serverEntry = dir.resolve("server/entry-http.js"),
        webRoot = dir.resolve("web"),
        agentEntry = dir.resolve("agent/zcode.cjs"),
        remoteBridgeEntry = dir.resolve("remote-bridge/index.mjs").takeIf(Files::isRegularFile),
        runtimeVersion = runtimeVersion,
    )

    // ---- 解压 ----

    /** 解压 zip 到 staging，逐条目做 zip-slip 校验（方案 §8.5），违规即抛错（staging 由调用方清理）。 */
    private fun extractZip(archive: Path, staging: Path) {
        val stagingRoot = staging.toAbsolutePath().normalize()
        Files.createDirectories(stagingRoot)
        ZipFile(archive.toFile()).use { zip ->
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                val target = safeEntryTarget(stagingRoot, entry.name)
                    ?: throw RuntimeProvisionException("运行时压缩包包含非法条目：${entry.name}")
                if (entry.isDirectory) {
                    Files.createDirectories(target)
                } else {
                    Files.createDirectories(target.parent)
                    zip.getInputStream(entry).use { input ->
                        Files.copy(input, target, StandardCopyOption.REPLACE_EXISTING)
                    }
                }
            }
        }
    }

    /**
     * zip-slip 校验：entry name 规范化后必须落在 staging 内。
     * 拒绝空名、绝对路径（`/`、`\` 开头）、Windows 盘符、`..` 越界。
     */
    private fun safeEntryTarget(staging: Path, entryName: String): Path? {
        if (entryName.isBlank()) return null
        if (entryName.startsWith('/') || entryName.startsWith('\\')) return null
        if (entryName.length >= 2 && entryName[1] == ':') return null
        val resolved = staging.resolve(entryName).normalize()
        if (!resolved.startsWith(staging)) return null
        return resolved
    }

    /** 解压后必需文件（与 package-runtime.mjs 的校验一致，方案 §5.1）；缺一抛错。 */
    private fun verifyRequiredFiles(dir: Path) {
        val missing = REQUIRED_FILES.filterNot { Files.isRegularFile(dir.resolve(it)) }
        if (missing.isNotEmpty()) {
            throw RuntimeProvisionException("解压后的运行时缺少必需文件：${missing.joinToString("、")}")
        }
    }

    /**
     * macOS spawn-helper 需要可执行位：遍历各处（含 node_modules 下）darwin-* 目录里的
     * spawn-helper，设为 rwxr-xr-x（0755）。文件系统不支持 POSIX（Windows）时静默跳过。
     */
    private fun applyPosixPermissions(dir: Path) {
        val posixSupported = runCatching {
            "posix" in dir.fileSystem.supportedFileAttributeViews()
        }.getOrDefault(false)
        if (!posixSupported) return
        Files.walk(dir).use { stream ->
            stream.filter(Files::isRegularFile)
                .filter { it.fileName.toString() == "spawn-helper" }
                .filter { it.parent != null && it.parent.fileName.toString().startsWith("darwin-") }
                .forEach { path ->
                    runCatching {
                        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rwxr-xr-x"))
                    }.onFailure { log?.warn("设置 spawn-helper 权限失败：$path", it) }
                }
        }
    }

    private fun writeCompleteInfo(dir: Path, manifest: RuntimeManifest) {
        val info = CompleteInfo(
            version = manifest.runtimeVersion,
            sha256 = manifest.sha256,
            size = manifest.size,
            installedAt = nowIso(),
        )
        Files.writeString(dir.resolve(COMPLETE_FILE), json.encodeToString(CompleteInfo.serializer(), info))
    }

    private fun atomicMove(source: Path, target: Path) {
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE)
        } catch (_: AtomicMoveNotSupportedException) {
            runCatching { Files.move(source, target, StandardCopyOption.REPLACE_EXISTING) }
                .onFailure { throw RuntimeProvisionException("无法落盘运行时目录 $target：${it.message}", it) }
        }
    }

    // ---- 通用工具 ----

    /** 数据根下的 runtime 目录：`<ZCODE_DATA_BASE_DIR|~/.zcode>/ide/runtime`。布局唯一出处见 [RuntimeLayout.defaultUserRuntimeRoot]。 */
    internal fun defaultRoot(): Path = RuntimeLayout.defaultUserRuntimeRoot()

    private fun sha256(file: Path): String {
        val digest = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(file).use { input ->
            val buffer = ByteArray(DOWNLOAD_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { ((it.toInt() and 0xff)).toString(16).padStart(2, '0') }
    }

    private fun mb(bytes: Long): String = "%.1f".format(Locale.ROOT, bytes / 1024.0 / 1024.0)

    private fun nowIso(): String = Instant.now().toString()

    private fun deleteRecursively(path: Path) {
        if (!Files.exists(path)) return
        runCatching {
            Files.walk(path).use { stream ->
                stream.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
            }
        }.onFailure { log?.warn("Failed to delete $path", it) }
    }

    /** 数字三元组（cleanup 用）：目录名 `0.1.0-xxx` 取 `-` 前，version `0.1.0+x` 取 `+` 前。 */
    private data class SemVer(val major: Int, val minor: Int, val patch: Int) : Comparable<SemVer> {
        override fun compareTo(other: SemVer): Int =
            compareValuesBy(this, other, SemVer::major, SemVer::minor, SemVer::patch)

        companion object {
            fun parse(text: String): SemVer? {
                val parts = text.split('.')
                if (parts.size != 3) return null
                val values = parts.map { it.toIntOrNull() ?: return null }
                return SemVer(values[0], values[1], values[2])
            }
        }
    }

    private val REQUIRED_FILES = listOf(
        "server/entry-http.js",
        "web/index.html",
        "agent/zcode.cjs",
        "remote-bridge/index.mjs",
        "LICENSE",
        "NOTICE.md",
        "THIRD-PARTY-NOTICES.md",
    )
}

/**
 * 运行期设置项解析（方案 §6.7 的优先级链）：env/系统属性 > 设置页（PropertiesComponent）> 默认值。
 *
 * [settingValue] 是 [RuntimeProvisioner]（下载源）与 [RuntimeUpdater]（manifest/channel/自动更新开关）
 * 共用的通用读取函数；设置页 [dev.zcode.ide.settings.ZCodeRuntimeConfigurable] 写入同一批持久化键。
 * 设置页层默认读 PropertiesComponent（platform 依赖）；单测注入 [storedValue] 的内存 fake，不引 platform。
 */
internal object RuntimeSettings {
    // ---- env / 系统属性键（调试逃生口；解析优先级最高） ----
    const val ENV_AUTO_UPDATE = "ZCODE_IDE_RUNTIME_AUTO_UPDATE"
    const val ENV_CHANNEL = "ZCODE_IDE_RUNTIME_CHANNEL"
    const val ENV_MANIFEST_URL = "ZCODE_IDE_RUNTIME_MANIFEST_URL"
    const val ENV_BASE_URL = "ZCODE_IDE_RUNTIME_BASE_URL"

    // ---- 设置页持久化键（本对象定义，解析链与设置页共用，防两边漂移） ----
    const val KEY_AUTO_UPDATE = "zcode.ide.runtime.autoUpdate"
    const val KEY_CHANNEL = "zcode.ide.runtime.channel"
    const val KEY_MANIFEST_URL = "zcode.ide.runtime.manifestUrl"

    /** base URL：系统属性与设置页共用同一个点分键（与 env 键不同名）。 */
    const val KEY_BASE_URL = "zcode.ide.runtime.baseUrl"

    // ---- 调试逃生口：显式允许 http:// 运行时源（默认关闭；生产必须 HTTPS） ----
    const val ENV_ALLOW_HTTP = "ZCODE_IDE_RUNTIME_ALLOW_HTTP"
    const val KEY_ALLOW_HTTP = "zcode.ide.runtime.allowHttp"

    private fun truthy(value: String?): Boolean =
        value?.trim()?.lowercase(Locale.ROOT) in setOf("1", "true", "yes", "on")

    /**
     * 是否已显式允许 HTTP 运行时源（系统属性 [KEY_ALLOW_HTTP] 或环境变量 [ENV_ALLOW_HTTP]）。
     * 只给本地联调用（七牛测试域名只支持 HTTP）；不读设置页，避免被持久化误开。
     */
    fun allowInsecureHttp(): Boolean =
        truthy(System.getProperty(KEY_ALLOW_HTTP)) || truthy(System.getenv(ENV_ALLOW_HTTP))

    /** 下载/清单 URL 放行判定：https 恒放行；http 仅在显式开关下放行（方案 §8.3 的调试例外）。 */
    fun isAllowedSourceUrl(url: String): Boolean =
        url.startsWith("https://") || (url.startsWith("http://") && allowInsecureHttp())

    @Volatile
    private var insecureWarned = false

    /** 首次放行 http 时告警一次（IDE 日志；单测环境无 platform 时静默）。 */
    fun warnInsecureOnce(url: String) {
        if (insecureWarned) return
        insecureWarned = true
        runCatching {
            Logger.getInstance("ZCodeIDE").warn(
                "已显式允许 HTTP 运行时源（仅本地联调；生产必须 HTTPS）：$url",
            )
        }
    }

    /** 设置页持久化读取；默认 PropertiesComponent（依赖 Application，单测环境抛错时静默返回未配置）。 */
    @Volatile
    internal var storedValue: (key: String) -> String? = { key ->
        runCatching { PropertiesComponent.getInstance().getValue(key) }.getOrNull()
    }

    /**
     * 三级解析：系统属性 [propKey] > env [envKey] > 设置页 [storedKey]；均未配置返回 null
     * （默认值由调用方决定）。取值 trim 后非空才算配置；[storedKey] 缺省与 [propKey] 相同
     * （base URL 的系统属性与设置页共用点分键）。
     */
    fun settingValue(propKey: String, envKey: String, storedKey: String = propKey): String? =
        System.getProperty(propKey)?.trim()?.takeIf(String::isNotBlank)
            ?: System.getenv(envKey)?.trim()?.takeIf(String::isNotBlank)
            ?: storedValue(storedKey)?.trim()?.takeIf(String::isNotBlank)
}
