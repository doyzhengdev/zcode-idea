package dev.zcode.ide.runtime

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

class RuntimeManifestSignatureTest {

    private fun generateKeyPair(): KeyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()

    /** 用测试私钥对数据签名，返回 base64（manifest.sig 的形态）。 */
    private fun sign(privateKey: PrivateKey, data: ByteArray): String {
        val signature = Signature.getInstance("Ed25519")
        signature.initSign(privateKey)
        signature.update(data)
        return Base64.getEncoder().encodeToString(signature.sign())
    }

    /** 把公钥包装成 PEM 字节（BEGIN/END + 64 列 base64），覆盖 decodePem 的解析路径。 */
    private fun pemOf(keyPair: KeyPair): ByteArray {
        val base64 = Base64.getMimeEncoder(64, "\n".toByteArray()).encode(keyPair.public.encoded)
        val pem = "-----BEGIN PUBLIC KEY-----\n" +
            base64.decodeToString() +
            "\n-----END PUBLIC KEY-----\n"
        return pem.toByteArray()
    }

    private val manifestBytes = """{"schemaVersion":1,"runtimeVersion":"0.1.0+abc"}""".toByteArray()

    @Test
    fun `signature verifies for matching key and bytes`() {
        val keyPair = generateKeyPair()
        val sig = sign(keyPair.private, manifestBytes)
        assertTrue(RuntimeManifest.verifySignature(manifestBytes, sig, pemOf(keyPair)))
    }

    @Test
    fun `signature rejects tampered manifest bytes`() {
        val keyPair = generateKeyPair()
        val sig = sign(keyPair.private, manifestBytes)
        val tampered = """{"schemaVersion":1,"runtimeVersion":"0.1.0+evil"}""".toByteArray()
        assertFalse(RuntimeManifest.verifySignature(tampered, sig, pemOf(keyPair)))
    }

    @Test
    fun `signature rejects different public key`() {
        val signer = generateKeyPair()
        val other = generateKeyPair()
        val sig = sign(signer.private, manifestBytes)
        assertFalse(RuntimeManifest.verifySignature(manifestBytes, sig, pemOf(other)))
    }

    @Test
    fun `signature rejects malformed inputs`() {
        val keyPair = generateKeyPair()
        val sig = sign(keyPair.private, manifestBytes)
        // 非 base64 的签名
        assertFalse(RuntimeManifest.verifySignature(manifestBytes, "!!!not-base64!!!", pemOf(keyPair)))
        // 坏 PEM
        assertFalse(RuntimeManifest.verifySignature(manifestBytes, sig, "not a pem".toByteArray()))
        // 空签名
        assertFalse(RuntimeManifest.verifySignature(manifestBytes, "", pemOf(keyPair)))
    }

    @Test
    fun `bundled signing key parses into an Ed25519 public key`() {
        val pemBytes = javaClass.classLoader
            .getResourceAsStream("runtime-signing-public.pem")
            ?.use { it.readBytes() }
        assertNotNull(pemBytes, "资源 runtime-signing-public.pem 应存在")

        val body = pemBytes!!.decodeToString()
            .lines()
            .filterNot { it.trimStart().startsWith("-----") }
            .joinToString("") { it.trim() }
        val publicKey = KeyFactory.getInstance("Ed25519")
            .generatePublic(X509EncodedKeySpec(Base64.getMimeDecoder().decode(body)))
        // 不同 JDK 对 Ed25519 的 algorithm 名有 "Ed25519" / "EdDSA" 两种写法
        assertTrue(publicKey.algorithm in setOf("Ed25519", "EdDSA"), publicKey.algorithm)

        // 用真实公钥走一遍验签流程：没有真实私钥，签名必然不通过，但不应抛异常。
        assertFalse(
            RuntimeManifest.verifySignature(
                manifestBytes,
                Base64.getEncoder().encodeToString(ByteArray(64)),
                pemBytes,
            ),
        )
    }
}
