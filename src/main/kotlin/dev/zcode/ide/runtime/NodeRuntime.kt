package dev.zcode.ide.runtime

import com.intellij.ide.util.PropertiesComponent
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.TimeUnit

data class NodeRuntime(val path: Path, val major: Int, val version: String) {
    companion object {
        const val MIN_MAJOR = 24
        private const val KEY = "zcode.ide.nodePath"

        private val isWindows: Boolean
            get() = System.getProperty("os.name").lowercase().contains("win")

        /**
         * @param includeSaved 是否把上次由插件自动安装的路径也当作候选。
         *   选 Node 时先用 `includeSaved = false` 找系统 24，再退回插件副本——
         *   否则一旦插件装过 Node，系统自己升级的 24.x 就永远轮不到。
         */
        fun find(includeSaved: Boolean = true): NodeRuntime? {
            val candidates = buildList {
                if (includeSaved) {
                    PropertiesComponent.getInstance().getValue(KEY)
                        ?.takeIf(String::isNotBlank)?.let { add(Paths.get(it)) }
                }
                System.getenv("ZCODE_IDE_NODE")?.takeIf(String::isNotBlank)?.let { add(Paths.get(it)) }
                findOnPath("node")?.let { add(it) }
                addAll(commonLocations())
            }.distinct()

            val probed = candidates.mapNotNull { probe(it) }
            // 官方 server 的 engines 是 >=24，但 25/26 尚未验证；优先精确使用 24.x。
            return probed.filter { it.major == MIN_MAJOR }.maxByOrNull { it.version }
                ?: probed.filter { it.major > MIN_MAJOR }.minByOrNull { it.major }
                ?: probed.maxByOrNull { it.major }
        }

        fun probe(path: Path): NodeRuntime? {
            if (!Files.isRegularFile(path)) return null
            return try {
                val process = ProcessBuilder(path.toString(), "-v")
                    .redirectErrorStream(true)
                    .start()
                val output = process.inputStream.bufferedReader().readText().trim()
                if (!process.waitFor(5, TimeUnit.SECONDS)) {
                    process.destroyForcibly()
                    return null
                }
                val version = output.removePrefix("v")
                val major = version.substringBefore('.').toIntOrNull() ?: return null
                NodeRuntime(path, major, version)
            } catch (_: Exception) {
                null
            }
        }

        fun save(path: Path?) {
            PropertiesComponent.getInstance().setValue(KEY, path?.toString() ?: "")
        }

        private fun findOnPath(name: String): Path? {
            val extensions = if (isWindows) listOf(".exe", ".cmd", "") else listOf("")
            val path = System.getenv("PATH").orEmpty()
            for (dir in path.split(File.pathSeparatorChar)) {
                if (dir.isBlank()) continue
                for (extension in extensions) {
                    val candidate = Paths.get(dir, name + extension)
                    if (Files.isRegularFile(candidate)) return candidate
                }
            }
            return null
        }

        private fun commonLocations(): List<Path> = buildList {
            if (isWindows) {
                add(Paths.get("C:/Program Files/nodejs/node.exe"))
                System.getenv("NVM_HOME")?.let { add(Paths.get(it, "node.exe")) }
                System.getenv("NVM_SYMLINK")?.let { add(Paths.get(it, "node.exe")) }
                // scoop 管理的 nvm：persist/nvm/nodejs/v24.x/node.exe
                System.getenv("USERPROFILE")?.let { home ->
                    val root = Paths.get(home, "scoop/persist/nvm/nodejs")
                    runCatching {
                        Files.list(root).use { stream ->
                            stream.filter(Files::isDirectory).forEach { add(it.resolve("node.exe")) }
                        }
                    }
                }
            } else {
                add(Paths.get("/usr/local/bin/node"))
                add(Paths.get("/usr/bin/node"))
                add(Paths.get(System.getProperty("user.home"), ".local/bin/node"))
            }
        }
    }
}
