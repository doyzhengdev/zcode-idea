package dev.zcode.ide.runtime

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.extensions.PluginId
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * ZCode 运行时布局。支持两种形态：
 * - 仓库布局：packages/server/dist + packages/web-ide/dist + apps/zcode-cli/.../zcode.cjs
 * - 打包布局：<root>/server + <root>/web + <root>/agent
 *
 * [runtimeVersion] 标识运行时版本，供 [ServerProcess] 做「残留 server 是否可复用」的判定：
 * - 用户目录（下载版）候选取 current.json 的 `version`；
 * - 其余候选从 `root/BUILD-INFO.json` 推导 `<pluginVersion>+<fork.commit 前 12 位>`；
 * - 推导不出（无 BUILD-INFO 或字段缺失）为 null。
 */
data class RuntimeLayout(
    val root: Path,
    val serverEntry: Path,
    val webRoot: Path,
    val agentEntry: Path,
    /** 插件自有：Web 远控 device 桥（打包布局为 remote-bridge/index.mjs）。 */
    val remoteBridgeEntry: Path? = null,
    val runtimeVersion: String? = null,
) {
    companion object {
        private const val PROP = "zcode.ide.runtime"
        private const val ENV = "ZCODE_IDE_RUNTIME"
        private const val DATA_BASE_DIR_ENV = "ZCODE_DATA_BASE_DIR"
        private const val COMPLETE_FILE = ".complete.json"

        private val json = Json { ignoreUnknownKeys = true }

        /**
         * 候选优先级（方案 §6.1）：系统属性 → env → vendor/ZCode（开发期）→ 插件自带（完整包）→
         * 用户目录（下载版，[RuntimeProvisioner] 的落地产物）。
         */
        fun resolve(): RuntimeLayout? = resolveFrom(candidateRoots(), defaultUserRuntimeRoot())

        /** 候选根列表与用户目录 runtime 根均可注入（供单测控制候选顺序与命中）。 */
        internal fun resolveFrom(candidateRoots: List<Path>, userRuntimeRoot: Path?): RuntimeLayout? =
            candidateRoots.firstNotNullOfOrNull(::fromRoot) ?: userRuntimeRoot?.let(::fromUserDir)

        /** 用户目录 runtime 根：`<ZCODE_DATA_BASE_DIR ?: ~/.zcode>/ide/runtime`（[RuntimeProvisioner.defaultRoot] 的同一布局）。 */
        internal fun defaultUserRuntimeRoot(): Path {
            val dataBase = System.getenv(DATA_BASE_DIR_ENV)?.trim()?.takeIf(String::isNotEmpty)
                ?: Paths.get(System.getProperty("user.home"), ".zcode").toString()
            return Paths.get(dataBase, "ide", "runtime")
        }

        private fun candidateRoots(): List<Path> = buildList {
            System.getProperty(PROP)?.takeIf(String::isNotBlank)?.let { add(Paths.get(it)) }
            System.getenv(ENV)?.takeIf(String::isNotBlank)?.let { add(Paths.get(it)) }
            // 开发期：工程 vendor/ZCode（官方源码工作副本）
            add(Paths.get(System.getProperty("user.dir", "."), "vendor", "ZCode"))
            // 安装态：插件自身目录下的 runtime（插件目录名由 zip 根目录决定，不能硬编码）
            PluginManagerCore.getPlugin(PluginId.getId("dev.zcode.ide"))?.pluginPath
                ?.let { add(it.resolve("runtime")) }
            // 兼容手动放置
            add(Paths.get(PathManager.getPluginsPath(), "zcode-ide", "runtime"))
        }

        private fun fromRoot(root: Path): RuntimeLayout? {
            if (!Files.isDirectory(root)) return null
            val version = buildInfoVersion(root)

            val stagedServer = root.resolve("server/entry-http.js")
            if (Files.isRegularFile(stagedServer)) {
                return RuntimeLayout(
                    root,
                    stagedServer,
                    root.resolve("web"),
                    root.resolve("agent/zcode.cjs"),
                    root.resolve("remote-bridge/index.mjs").takeIf(Files::isRegularFile),
                    version,
                )
            }

            val repoServer = root.resolve("packages/server/dist/entry-http.js")
            if (Files.isRegularFile(repoServer)) {
                val web = listOf(
                    root.resolve("packages/web-ide/dist"),
                    root.resolve("packages/web/dist"),
                ).firstOrNull(Files::isDirectory) ?: return null
                val agent = root.resolve("apps/zcode-cli/packages/cli/dist/zcode.cjs")
                if (!Files.isRegularFile(agent)) return null
                return RuntimeLayout(
                    root,
                    repoServer,
                    web,
                    agent,
                    root.resolve("packages/ide-remote-bridge/dist/index.mjs")
                        .takeIf(Files::isRegularFile),
                    version,
                )
            }
            return null
        }

        /**
         * 用户目录（下载版）候选：读 `current.json`，指向的版本目录完整才命中；
         * 指针缺失/损坏、目录缺失或不完整一律跳过该候选（不抛错，交给后续候选/下载兜底）。
         */
        private fun fromUserDir(runtimeRoot: Path): RuntimeLayout? {
            val pointer = runCatching {
                json.decodeFromString(UserPointer.serializer(), Files.readString(runtimeRoot.resolve("current.json")))
            }.getOrNull() ?: return null
            val version = pointer.version.takeIf(String::isNotBlank) ?: return null
            val dir = runtimeRoot.resolve(pointer.path)
            if (!Files.isDirectory(dir)) return null
            // 有效性口径与 RuntimeProvisioner.validCurrentLayout 一致：目录 + .complete.json + 两个入口文件。
            if (!Files.isRegularFile(dir.resolve(COMPLETE_FILE))) return null
            if (!Files.isRegularFile(dir.resolve("server/entry-http.js"))) return null
            if (!Files.isRegularFile(dir.resolve("web/index.html"))) return null
            return fromRoot(dir)?.copy(runtimeVersion = version) ?: return null
        }

        /** `root/BUILD-INFO.json`（build-runtime.mjs 的溯源产物）；缺失或损坏返回 null。 */
        internal fun buildInfo(root: Path): BuildInfo? {
            val file = root.resolve("BUILD-INFO.json")
            if (!Files.isRegularFile(file)) return null
            return runCatching { json.decodeFromString(BuildInfo.serializer(), Files.readString(file)) }
                .getOrNull()
        }

        /** 从 BUILD-INFO 推导 runtimeVersion：`<pluginVersion>+<fork.commit 前 12 位>`；字段缺失则 null。 */
        internal fun buildInfoVersion(root: Path): String? {
            val info = buildInfo(root) ?: return null
            val plugin = info.pluginVersion?.takeIf(String::isNotBlank) ?: return null
            val commit = info.fork?.commit?.takeIf(String::isNotBlank) ?: return null
            return "$plugin+${commit.take(12)}"
        }

        /**
         * BUILD-INFO.json 结构（只取需要的字段，其余忽略）。
         * 注意 `toolchain.node` 是**构建机**的 Node 版本，与 runtime 运行所需无关，不在此建模。
         */
        @Serializable
        internal data class BuildInfo(
            val pluginVersion: String? = null,
            val fork: Fork? = null,
        ) {
            @Serializable
            internal data class Fork(val commit: String? = null)
        }

        /** current.json 的结构（与 [RuntimeProvisioner.Pointer] 同一冻结格式，只取需要的字段）。 */
        @Serializable
        private data class UserPointer(val version: String = "", val path: String = "")
    }
}
