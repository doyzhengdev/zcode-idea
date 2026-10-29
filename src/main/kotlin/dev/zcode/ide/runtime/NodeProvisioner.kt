package dev.zcode.ide.runtime

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.zip.ZipFile

/**
 * 由插件自己保证 Node 运行时，不依赖 ezn：
 *
 * 1. 先找系统里现成的 Node 24（设置项 / 环境变量 / PATH / 常见安装目录 / 上次装好的副本）；
 * 2. 不是 24.x 或完全没有 Node 时，从淘宝镜像（npmmirror）下载对应平台的 Node 24，
 *    用 SHASUMS256.txt 校验后解压到用户数据目录的 `runtime-node/v<version>`；
 *    [ensure] 的 `pinnedVersion` 非空时直接下载锁定版本（不再遍历 index.json 选最高）；
 * 3. 安装保留旧版本：只重装同名 `v<version>`，不同版本目录一律保留；
 * 4. 返回可用的 [NodeRuntime]，server 与 agent 都用它启动。
 *
 * 旧版插件把 Node 装在插件目录下；[ensure] 开头会把它 best-effort 迁到用户目录（同名跳过，
 * 失败静默忽略让下载兜底），迁移只做一次（标记文件）。
 *
 * 调试用环境变量：
 * - `ZCODE_IDE_NODE_MIRROR`：覆盖镜像根（默认 registry.npmmirror.com，失败回落 nodejs.org）
 * - `ZCODE_IDE_FORCE_NODE_DOWNLOAD=1`：忽略本机 Node，强制走插件内副本/下载（验证安装链路）
 */
object NodeProvisioner {

    private val log = Logger.getInstance("ZCodeIDE")

    private const val TARGET_MAJOR = 24
    private const val DEFAULT_MIRROR = "https://registry.npmmirror.com/-/binary/node"
    private const val FALLBACK_MIRROR = "https://nodejs.org/dist"
    private const val MIRROR_ENV = "ZCODE_IDE_NODE_MIRROR"
    private const val FORCE_ENV = "ZCODE_IDE_FORCE_NODE_DOWNLOAD"

    /** 迁移标记：旧插件目录 runtime-node 的版本目录已迁移（或尝试迁移）过，不重复做。 */
    private const val MIGRATED_MARKER = ".migrated"

    private const val DOWNLOAD_REPORT_STEP = 2L * 1024 * 1024

    private val http: HttpClient = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NORMAL)
        .connectTimeout(Duration.ofSeconds(20))
        .build()

    private val versionComparator = Comparator<String> { left, right ->
        val leftParts = left.split('.')
        val rightParts = right.split('.')
        for (index in 0 until maxOf(leftParts.size, rightParts.size)) {
            val diff = (leftParts.getOrNull(index)?.toIntOrNull() ?: 0) -
                (rightParts.getOrNull(index)?.toIntOrNull() ?: 0)
            if (diff != 0) return@Comparator diff
        }
        0
    }

    /**
     * 确保有可用的 Node 24。可能触发一次几十 MB 的下载，**必须在后台线程调用**。
     * [status] 用于把进度回显到面板（调用方负责切回 EDT）。
     *
     * [pinnedVersion]（如 runtime manifest 的 `nodeVersion`）锁定下载版本：仅影响「都没有、
     * 需要下载」的分支——本机已有 24.x 或用户目录已装 24.x 时照旧复用。
     */
    fun ensure(status: (String) -> Unit = {}, pinnedVersion: String? = null): NodeRuntime {
        migrateLegacyInstallations()

        // 调试开关：忽略本机 Node，用于验证“插件内安装/复用”链路（有副本就复用，没有就下载）。
        val ignoreSystem = System.getenv(FORCE_ENV) == "1"

        if (!ignoreSystem) {
            // 1) 系统/用户显式指定的 Node 24 优先（忽略插件上次记录的路径）。
            NodeRuntime.find(includeSaved = false)?.let { node ->
                if (node.major == TARGET_MAJOR) {
                    NodeRuntime.save(node.path)
                    status("使用本机 Node ${node.version}")
                    return node
                }
                status("本机 Node ${node.version} 不满足要求（需要 $TARGET_MAJOR.x），准备自动安装…")
            }
        }

        // 2) 用户目录里插件自己安装过的副本。
        installedNode()?.let { node ->
            NodeRuntime.save(node.path)
            status("使用插件已安装的 Node ${node.version}")
            return node
        }

        return install(status, pinnedVersion)
    }

    /** Node 副本安装根：固定在用户数据目录 `<ZCODE_DATA_BASE_DIR ?: user.home>/.zcode/ide/runtime-node`。 */
    fun installRoot(): Path = installRootAt(dataBaseDir())

    /** [installRoot] 的可注入形态（供单测）。 */
    internal fun installRootAt(base: Path): Path = base.resolve(".zcode").resolve("ide").resolve("runtime-node")

    private fun dataBaseDir(): Path {
        val base = System.getenv("ZCODE_DATA_BASE_DIR")?.trim()?.takeIf { it.isNotEmpty() }
            ?: System.getProperty("user.home")
        return Paths.get(base)
    }

    /**
     * 旧插件目录 runtime-node（薄插件之前的安装把 Node 装在插件目录下）best-effort 迁到新 installRoot：
     * 逐个移动 `v*` 版本目录（同名跳过；IO 失败静默忽略，让后续下载兜底），迁移只做一次（标记文件）。
     */
    internal fun migrateLegacyInstallationsAt(root: Path, legacyRoot: Path?) {
        if (legacyRoot == null || legacyRoot == root) return
        if (!Files.isDirectory(legacyRoot)) return
        if (Files.exists(root.resolve(MIGRATED_MARKER))) return

        val versions = runCatching {
            Files.list(legacyRoot).use { stream ->
                stream.filter { Files.isDirectory(it) && it.fileName.toString().startsWith("v") }.toList()
            }
        }.getOrDefault(emptyList())
        if (versions.isEmpty()) return

        runCatching { Files.createDirectories(root) }
        for (source in versions) {
            val target = root.resolve(source.fileName.toString())
            if (Files.exists(target)) continue
            // Files.move 无 ATOMIC_MOVE 时自带跨盘 copy+delete 语义；失败静默忽略，交给后续下载兜底。
            runCatching { Files.move(source, target) }
                .onFailure { log.warn("Failed to migrate legacy Node ${source.fileName} to $target", it) }
        }
        runCatching { Files.writeString(root.resolve(MIGRATED_MARKER), Instant.now().toString()) }
        log.info("Migrated legacy runtime-node from $legacyRoot to $root")
    }

    private fun migrateLegacyInstallations() {
        val legacy = PluginManagerCore.getPlugin(PluginId.getId("dev.zcode.ide"))?.pluginPath
            ?.resolve("runtime-node")
        migrateLegacyInstallationsAt(installRoot(), legacy)
    }

    private fun installedNode(): NodeRuntime? {
        val root = installRoot()
        if (!Files.isDirectory(root)) return null
        return runCatching {
            val candidates = Files.list(root).use { stream ->
                stream
                    .filter(Files::isDirectory)
                    .filter { it.fileName.toString().startsWith("v") }
                    .map { it.resolve(nodeRelativePath()) }
                    .filter(Files::isRegularFile)
                    .toList()
            }
            selectInstalled(candidates.mapNotNull { NodeRuntime.probe(it) })
        }.getOrNull()
    }

    /**
     * 已装副本的选取：只接受 major == [TARGET_MAJOR] 的 24.x，取最高版本。
     * 评审 F2：历史污染的非 24 版本一律不复用（否则会被后续所有 ensure 持久锁定、
     * 永不自装 24），交由后续下载分支装回 24。
     */
    internal fun selectInstalled(nodes: List<NodeRuntime>): NodeRuntime? =
        nodes.asSequence()
            .filter { it.major == TARGET_MAJOR }
            .maxWithOrNull(compareBy(versionComparator) { it.version })

    private fun install(status: (String) -> Unit, pinnedVersion: String?): NodeRuntime {
        val root = installRoot()
        Files.createDirectories(root)

        val destination = if (pinnedVersion != null) {
            // 锁定版本：直接下 v<pinnedVersion>，逐个镜像尝试直到成功。
            installPinnedAt(root, pinnedVersion, status)
        } else {
            val release = resolveRelease(status)
            installFromMirror(root, release.mirror, release.version, status)
        }

        val nodePath = destination.resolve(nodeRelativePath())
        val node = NodeRuntime.probe(nodePath)
            ?: throw IllegalStateException("解压后未找到可用的 node：$nodePath")
        NodeRuntime.save(node.path)
        log.info("Provisioned Node ${node.version} at ${node.path}")
        status("Node ${node.version} 就绪")
        return node
    }

    /**
     * 锁定版本安装（pinnedVersion 分支）：不再遍历 index.json 选最高，直接按 [version] 下载；
     * 逐个镜像尝试直到成功（npmmirror → nodejs.org 回落，`ZCODE_IDE_NODE_MIRROR` 覆盖）。
     * [download]/[shasums] 可注入（单测不起网络）。
     */
    internal fun installPinnedAt(
        root: Path,
        version: String,
        status: (String) -> Unit = {},
        download: Download = ::downloadFile,
        shasums: Shasums = ::fetchShasums,
    ): Path {
        val failures = mutableListOf<String>()
        for (mirror in mirrors()) {
            try {
                return installFromMirror(root, mirror, version, status, download, shasums)
            } catch (e: Exception) {
                failures += "$mirror: ${e.message}"
            }
        }
        throw IllegalStateException("无法从镜像下载 Node v$version：" + failures.joinToString("；"))
    }

    /**
     * 从单个镜像安装指定版本：下载 → SHASUMS256 校验 → 解压 → 落盘 `v<version>`。
     * 同名版本目录已存在才删除重装；其他版本目录一律保留。
     * [download]/[shasums] 可注入（单测不起网络）。
     */
    internal fun installFromMirror(
        root: Path,
        mirror: String,
        version: String,
        status: (String) -> Unit = {},
        download: Download = ::downloadFile,
        shasums: Shasums = ::fetchShasums,
    ): Path {
        val archiveName = archiveName(version)
        val tempDir = root.resolve(".tmp-${UUID.randomUUID()}")
        Files.createDirectories(tempDir)
        try {
            val archive = tempDir.resolve(archiveName)
            status("正在下载 Node $version（${platformLabel()}）…")
            download(mirror, version, archiveName, archive, status)
            status("正在校验 Node $version…")
            verifyChecksum(mirror, version, archiveName, archive, shasums)
            status("正在解压 Node $version…")
            val extracted = extract(archive, tempDir)

            val destination = root.resolve("v$version")
            // 只重装同名版本；不同版本目录一律保留（多 runtime 版本可能各锁不同的 Node）。
            if (Files.exists(destination)) deleteRecursively(destination)
            Files.move(extracted, destination, StandardCopyOption.REPLACE_EXISTING)
            return destination
        } finally {
            deleteRecursively(tempDir)
        }
    }

    private data class Release(val mirror: String, val version: String)

    private fun resolveRelease(status: (String) -> Unit): Release {
        val failures = mutableListOf<String>()
        for (mirror in mirrors()) {
            val versions = runCatching { fetchVersions(mirror) }
                .onFailure { failures += "$mirror: ${it.message}" }
                .getOrNull()
                ?: continue
            val best = versions
                .filter { it.startsWith("v$TARGET_MAJOR.") }
                .maxWithOrNull(versionComparator)
                ?: continue
            return Release(mirror, best.removePrefix("v"))
        }
        status("无法获取 Node $TARGET_MAJOR 版本列表")
        throw IllegalStateException(
            "无法从镜像获取 Node $TARGET_MAJOR 版本列表：" + failures.joinToString("；"),
        )
    }

    private fun fetchVersions(mirror: String): List<String> {
        val text = httpText("$mirror/index.json")
        return Json.parseToJsonElement(text).jsonArray.mapNotNull { element ->
            element.jsonObject["version"]?.jsonPrimitive?.content
        }
    }

    private fun mirrors(): List<String> {
        val override = System.getenv(MIRROR_ENV)?.trim()?.takeIf { it.isNotEmpty() }
        return listOfNotNull(override, DEFAULT_MIRROR, FALLBACK_MIRROR).distinct()
    }

    private fun downloadFile(
        mirror: String,
        version: String,
        archiveName: String,
        target: Path,
        status: (String) -> Unit,
    ) {
        val url = "$mirror/v$version/$archiveName"
        val request = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofMinutes(15))
            .GET()
            .build()
        val response = http.send(request, HttpResponse.BodyHandlers.ofInputStream())
        if (response.statusCode() != 200) {
            throw IllegalStateException("下载失败（HTTP ${response.statusCode()}）：$url")
        }
        val total = response.headers().firstValueAsLong("content-length").orElse(-1L)
        response.body().use { input ->
            Files.newOutputStream(target).use { output ->
                val buffer = ByteArray(128 * 1024)
                var written = 0L
                var reported = 0L
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    output.write(buffer, 0, read)
                    written += read
                    if (total > 0 && written - reported >= DOWNLOAD_REPORT_STEP) {
                        reported = written
                        status(
                            "正在下载 Node $version：" +
                                "${written / 1024 / 1024} / ${total / 1024 / 1024} MB",
                        )
                    }
                }
            }
        }
        if (Files.size(target) == 0L) throw IllegalStateException("下载的 Node 安装包为空：$url")
    }

    private fun fetchShasums(mirror: String, version: String, archiveName: String): String =
        httpText("$mirror/v$version/SHASUMS256.txt")

    private fun verifyChecksum(
        mirror: String,
        version: String,
        archiveName: String,
        archive: Path,
        shasums: (mirror: String, version: String, archiveName: String) -> String,
    ) {
        val expected = shasums(mirror, version, archiveName)
            .lineSequence()
            .map(String::trim)
            .firstOrNull { it.endsWith("  $archiveName") || it.endsWith(" *$archiveName") }
            ?.substringBefore(' ')
            ?: throw IllegalStateException("SHASUMS256.txt 中找不到 $archiveName")
        val actual = sha256(archive)
        if (!actual.equals(expected, ignoreCase = true)) {
            throw IllegalStateException("Node 安装包 SHA256 校验失败：期望 $expected，实际 $actual")
        }
    }

    private fun extract(archive: Path, tempDir: Path): Path {
        if (archive.fileName.toString().endsWith(".zip")) {
            ZipFile(archive.toFile()).use { zip ->
                for (entry in zip.entries()) {
                    val output = tempDir.resolve(entry.name).normalize()
                    if (!output.startsWith(tempDir)) {
                        throw IllegalStateException("非法压缩包条目：${entry.name}")
                    }
                    if (entry.isDirectory) {
                        Files.createDirectories(output)
                    } else {
                        Files.createDirectories(output.parent)
                        zip.getInputStream(entry).use { input ->
                            Files.copy(input, output, StandardCopyOption.REPLACE_EXISTING)
                        }
                    }
                }
            }
        } else {
            val process = ProcessBuilder("tar", "-xzf", archive.toString(), "-C", tempDir.toString())
                .redirectErrorStream(true)
                .start()
            val output = process.inputStream.bufferedReader().readText()
            if (!process.waitFor(5, TimeUnit.MINUTES)) {
                process.destroyForcibly()
                throw IllegalStateException("解压超时：$archive")
            }
            if (process.exitValue() != 0) {
                throw IllegalStateException("解压失败（tar exit ${process.exitValue()}）：$output")
            }
        }

        return Files.list(tempDir).use { stream ->
            stream
                .filter(Files::isDirectory)
                .filter { it.fileName.toString().startsWith("node-") }
                .findFirst()
                .orElse(null)
        } ?: throw IllegalStateException("压缩包结构异常：没有 node-* 顶层目录")
    }

    private fun nodeRelativePath(): String = if (isWindows()) "node.exe" else "bin/node"

    private fun archiveName(version: String): String {
        val platform = platformTag()
        val arch = archTag()
        return if (platform == "win") {
            "node-v$version-win-$arch.zip"
        } else {
            "node-v$version-$platform-$arch.tar.gz"
        }
    }

    private fun platformTag(): String {
        val os = System.getProperty("os.name").lowercase()
        return when {
            os.contains("win") -> "win"
            os.contains("mac") -> "darwin"
            else -> "linux"
        }
    }

    private fun archTag(): String = when (System.getProperty("os.arch").lowercase()) {
        "aarch64", "arm64" -> "arm64"
        else -> "x64"
    }

    private fun platformLabel(): String = "${platformTag()}-${archTag()}"

    private fun isWindows(): Boolean =
        System.getProperty("os.name").lowercase().contains("win")

    private fun httpText(url: String): String {
        val request = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(60))
            .GET()
            .build()
        val response = http.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() != 200) {
            throw IllegalStateException("HTTP ${response.statusCode()}：$url")
        }
        return response.body()
    }

    private fun sha256(file: Path): String {
        val digest = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(file).use { input ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    }

    private fun deleteRecursively(path: Path) {
        if (!Files.exists(path)) return
        runCatching {
            Files.walk(path).use { stream ->
                stream.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
            }
        }.onFailure { log.warn("Failed to delete $path", it) }
    }
}

/** Node 安装包下载实现（默认网络下载，测试可注入本地压缩包）。 */
internal typealias Download = (
    mirror: String,
    version: String,
    archiveName: String,
    target: Path,
    status: (String) -> Unit,
) -> Unit

/** SHASUMS256.txt 获取实现（测试可注入本地内容）。 */
internal typealias Shasums = (mirror: String, version: String, archiveName: String) -> String
