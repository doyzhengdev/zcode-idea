package dev.zcode.ide.runtime

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * ZCode 运行时清单（方案 RUNTIME-DISTRIBUTION.md §4）。
 *
 * 字段与 `scripts/package-runtime.mjs` 生成的 manifest 一一对应；插件内置一份 baseline
 * （`resources/runtime-manifest.json`），远端清单由后续任务（RuntimeUpdater）拉取后，
 * 先用 [verifySignature] 验签，再用 [isCompatible] 做下载前置检查。
 */
@Serializable
data class RuntimeManifest(
    val schemaVersion: Int,
    val channel: String,
    /** 形如 `<major.minor.patch>+<commit12>`；`+` 后是 fork commit hash，无序、不参与版本比较。 */
    val runtimeVersion: String,
    val runtimeApiVersion: Int,
    val minPluginVersion: String,
    /** 形如 `0.1.*`：major.minor 相等即可，patch 任意。 */
    val maxPluginVersion: String,
    val nodeVersion: String,
    /** 相对 CDN 根的对象键；下载地址 = base URL + [archivePath]。 */
    val archivePath: String,
    val sha256: String,
    val size: Long,
    val uncompressedSize: Long,
    val builtAt: String,
    val forkCommit: String,
    val notes: String = "",
) {
    /** 版本目录名：runtimeVersion 的 `+` 换成 `-`（如 `0.1.0-cf345dcb7d0a`），对文件名安全。 */
    val versionDir: String
        get() = runtimeVersion.replace('+', '-')

    /**
     * 本清单是否比 [other] 新：只比较 `major.minor.patch` 数字三元组，严格大于才算新；
     * `+` 后的 commit hash 无序、不参与比较；版本相同不算新（同版本不重装）；
     * 任一数字部分解析失败返回 false。
     */
    fun isNewerThan(other: RuntimeManifest): Boolean {
        val mine = numericParts(runtimeVersion) ?: return false
        val theirs = numericParts(other.runtimeVersion) ?: return false
        return when {
            mine.first != theirs.first -> mine.first > theirs.first
            mine.second != theirs.second -> mine.second > theirs.second
            else -> mine.third > theirs.third
        }
    }

    /** 下载前置兼容检查（方案 §4.4）：schema、runtime API、插件版本区间、sha256/size 全部满足才允许下载。 */
    fun isCompatible(pluginVersion: String): Boolean {
        if (schemaVersion != SCHEMA_VERSION) return false
        if (runtimeApiVersion != RUNTIME_API_VERSION) return false
        if (!atLeast(minPluginVersion, pluginVersion)) return false
        if (!matchesMax(pluginVersion, maxPluginVersion)) return false
        if (sha256.length != 64 || sha256.any { !it.isHexDigit() }) return false
        if (size <= 0) return false
        return true
    }

    companion object {
        /**
         * 当前插件版本。与 `gradle.properties` 的 `pluginVersion` **同步维护**
         * （运行期读 plugin.xml / gradle.properties 都太重，取常量）。
         */
        const val PLUGIN_VERSION = "0.1.0"

        /** manifest 结构版本；[isCompatible] 只接受 1。 */
        const val SCHEMA_VERSION = 1

        /** 插件↔runtime 契约版本；契约变化时 +1，manifest 的 runtimeApiVersion 必须与之相等。 */
        const val RUNTIME_API_VERSION = 1

        private val json = Json { ignoreUnknownKeys = true }

        /** 解析 manifest 字节（未知字段忽略）；任何异常（坏 JSON、缺必需字段）返回 null，不抛。 */
        fun parse(bytes: ByteArray): RuntimeManifest? = runCatching {
            json.decodeFromString(serializer(), bytes.decodeToString())
        }.getOrNull()

        /** 读插件内置 baseline（`resources/runtime-manifest.json`）；失败返回 null。 */
        fun loadBaseline(): RuntimeManifest? = runCatching {
            RuntimeManifest::class.java.classLoader
                .getResourceAsStream("runtime-manifest.json")
                ?.use { it.readBytes() }
                ?.let(::parse)
        }.getOrNull()

        /**
         * Ed25519 验签（方案 §4.3）：[manifestBytes] 是被签的原始字节，[sigBase64] 是 manifest.sig 内容，
         * [publicKeyPem] 是 PEM 公钥字节。任何异常返回 false。
         */
        fun verifySignature(manifestBytes: ByteArray, sigBase64: String, publicKeyPem: ByteArray): Boolean =
            runCatching {
                val publicKey = KeyFactory.getInstance("Ed25519")
                    .generatePublic(X509EncodedKeySpec(decodePem(publicKeyPem)))
                Signature.getInstance("Ed25519").run {
                    initVerify(publicKey)
                    update(manifestBytes)
                    verify(Base64.getDecoder().decode(sigBase64.trim()))
                }
            }.getOrDefault(false)

        /** 当前插件版本（[PLUGIN_VERSION] 的函数形态，供调用方按需取）。 */
        fun currentPluginVersion(): String = PLUGIN_VERSION

        // ---- 私有工具 ----

        /** `major.minor.patch` 数字三元组；忽略 `+` 及其后内容；段数不为 3 或含非数字返回 null。 */
        private fun numericParts(version: String): Triple<Int, Int, Int>? {
            val parts = version.substringBefore('+').split('.')
            if (parts.size != 3) return null
            val (major, minor, patch) = parts.map { it.toIntOrNull() ?: return null }
            return Triple(major, minor, patch)
        }

        /** `min <= plugin`（数字三元组比较；任一解析失败返回 false）。 */
        private fun atLeast(min: String, plugin: String): Boolean {
            val minParts = numericParts(min) ?: return false
            val pluginParts = numericParts(plugin) ?: return false
            return when {
                pluginParts.first != minParts.first -> pluginParts.first > minParts.first
                pluginParts.second != minParts.second -> pluginParts.second > minParts.second
                else -> pluginParts.third >= minParts.third
            }
        }

        /** maxPluginVersion 通配匹配：`0.1.*` 表示 major.minor 相等、patch 任意；`*` 段之后的段不再检查。 */
        private fun matchesMax(pluginVersion: String, max: String): Boolean {
            val pluginParts = pluginVersion.substringBefore('+').split('.')
            val maxParts = max.split('.')
            for (index in maxParts.indices) {
                val part = maxParts[index]
                if (part == "*") return true
                val maxNum = part.toIntOrNull() ?: return false
                val pluginNum = pluginParts.getOrNull(index)?.toIntOrNull() ?: return false
                if (pluginNum != maxNum) return false
            }
            return pluginParts.size <= maxParts.size
        }

        private fun Char.isHexDigit(): Boolean =
            isDigit() || this in 'a'..'f' || this in 'A'..'F'

        /** PEM → DER：剥 BEGIN/END 头尾与所有空白，再 Base64 解码。 */
        private fun decodePem(pem: ByteArray): ByteArray {
            val body = pem.decodeToString()
                .lineSequence()
                .filterNot { it.trimStart().startsWith("-----") }
                .joinToString("") { it.trim() }
            return Base64.getMimeDecoder().decode(body)
        }
    }
}
