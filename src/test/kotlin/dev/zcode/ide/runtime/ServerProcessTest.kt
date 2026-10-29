package dev.zcode.ide.runtime

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * [ServerProcess] 的纯逻辑部分（不启动进程、不依赖 IntelliJ platform）：
 * 残留 server 的版本比较与处理决策、netstat/lsof 输出解析。
 */
class ServerProcessTest {

    // ---- 版本比较与残留 server 处理决策（方案 §6.5） ----

    @Test
    fun `same runtime version reuses stale server without pid lookup`() {
        var pidLookupInvoked = false
        val handling = ServerProcess.staleServerHandling(
            persistedVersion = "0.1.0+cf345dcb7d0a",
            currentVersion = "0.1.0+cf345dcb7d0a",
            hasOwnProcess = false,
        ) {
            pidLookupInvoked = true
            4321
        }
        assertEquals(ServerProcess.StaleServerHandling.Reuse, handling)
        assertFalse(pidLookupInvoked, "版本一致时不应做端口 PID 查询")
    }

    @Test
    fun `null on either side is treated as different`() {
        val pidLookup: () -> Int? = { error("版本不一致才需要查询 PID，但本组用例只断言非 Reuse") }

        assertEquals(
            ServerProcess.StaleServerHandling.KillOwnProcess,
            ServerProcess.staleServerHandling(null, "0.1.0+cf345dcb7d0a", hasOwnProcess = true, pidByPort = pidLookup),
        )
        assertEquals(
            ServerProcess.StaleServerHandling.KillOwnProcess,
            ServerProcess.staleServerHandling("0.1.0+cf345dcb7d0a", null, hasOwnProcess = true, pidByPort = pidLookup),
        )
        // 双方均为 null（如开发期 vendor 布局无 BUILD-INFO）：也视为不同。
        assertEquals(
            ServerProcess.StaleServerHandling.KillOwnProcess,
            ServerProcess.staleServerHandling(null, null, hasOwnProcess = true, pidByPort = pidLookup),
        )
    }

    @Test
    fun `different version kills own child process without pid lookup`() {
        var pidLookupInvoked = false
        val handling = ServerProcess.staleServerHandling(
            persistedVersion = "0.1.0+aaaaaaaaaaaa",
            currentVersion = "0.2.0+bbbbbbbbbbbb",
            hasOwnProcess = true,
        ) {
            pidLookupInvoked = true
            4321
        }
        assertEquals(ServerProcess.StaleServerHandling.KillOwnProcess, handling)
        assertFalse(pidLookupInvoked, "本会话子进程可直接 killTree，无需查端口")
    }

    @Test
    fun `different version kills by port pid when found`() {
        val handling = ServerProcess.staleServerHandling(
            persistedVersion = "0.1.0+aaaaaaaaaaaa",
            currentVersion = "0.2.0+bbbbbbbbbbbb",
            hasOwnProcess = false,
        ) { 4321 }
        assertEquals(ServerProcess.StaleServerHandling.KillByPid(4321), handling)
    }

    @Test
    fun `different version switches port when pid not found`() {
        val handling = ServerProcess.staleServerHandling(
            persistedVersion = "0.1.0+aaaaaaaaaaaa",
            currentVersion = "0.2.0+bbbbbbbbbbbb",
            hasOwnProcess = false,
        ) { null }
        assertEquals(ServerProcess.StaleServerHandling.SwitchPort, handling)
    }

    @Test
    fun `isSameRuntimeVersion is null safe`() {
        assertTrue(ServerProcess.isSameRuntimeVersion("0.1.0+abc", "0.1.0+abc"))
        assertFalse(ServerProcess.isSameRuntimeVersion("0.1.0+abc", "0.1.0+def"))
        assertFalse(ServerProcess.isSameRuntimeVersion(null, "0.1.0+abc"))
        assertFalse(ServerProcess.isSameRuntimeVersion("0.1.0+abc", null))
        assertFalse(ServerProcess.isSameRuntimeVersion(null, null))
    }

    // ---- Windows netstat 输出解析 ----

    @Test
    fun `parse netstat pid for listening line`() {
        val output = """
            活动连接

              协议  本地地址          外部地址        状态           PID
              TCP    127.0.0.1:7777         0.0.0.0:0              LISTENING       12345
              TCP    127.0.0.1:7777         127.0.0.1:50000        ESTABLISHED     12345
        """.trimIndent()
        assertEquals(12345, ServerProcess.parseNetstatPid(output, 7777))
    }

    @Test
    fun `netstat matches ipv6 wildcard listening line`() {
        val output = "  TCP    [::]:7777              [::]:0                 LISTENING       12346"
        assertEquals(12346, ServerProcess.parseNetstatPid(output, 7777))
    }

    @Test
    fun `netstat ignores established rows and foreign-address matches`() {
        val output = """
              TCP    127.0.0.1:7777         127.0.0.1:50000        ESTABLISHED     12345
              TCP    10.0.0.5:50001         93.184.216.34:7777     LISTENING       999
              UDP    0.0.0.0:5353           *:*                                    888
        """.trimIndent()
        assertNull(ServerProcess.parseNetstatPid(output, 7777), "只有本地地址列命中且 LISTENING 的 TCP 行才算")
    }

    @Test
    fun `netstat port suffix is not a prefix match`() {
        // 本地端口 18080 不应匹配目标端口 8080。
        val output = "  TCP    127.0.0.1:18080        0.0.0.0:0              LISTENING       777"
        assertNull(ServerProcess.parseNetstatPid(output, 8080))
        assertEquals(777, ServerProcess.parseNetstatPid(output, 18080))
    }

    @Test
    fun `netstat returns null on garbage output`() {
        assertNull(ServerProcess.parseNetstatPid("", 7777))
        assertNull(ServerProcess.parseNetstatPid("command not found", 7777))
    }

    // ---- Unix lsof 输出解析 ----

    @Test
    fun `parse lsof pid list`() {
        assertEquals(12345, ServerProcess.parseLsofPid("12345\n12350\n"))
        assertEquals(7, ServerProcess.parseLsofPid("  7  \nnot-a-pid\n"))
        assertNull(ServerProcess.parseLsofPid(""))
        assertNull(ServerProcess.parseLsofPid("lsof: no process found"))
    }
}
