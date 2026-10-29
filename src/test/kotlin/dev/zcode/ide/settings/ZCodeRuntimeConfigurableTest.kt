package dev.zcode.ide.settings

import dev.zcode.ide.runtime.CheckResult
import dev.zcode.ide.runtime.NodeRuntime
import dev.zcode.ide.runtime.Outcome
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Paths

/**
 * ZCodeRuntimeConfigurable 的纯函数逻辑（状态文案/版本文案/渠道归一化）。
 * 只调 companion 静态函数，不实例化 Configurable、不触碰 platform。
 */
class ZCodeRuntimeConfigurableTest {

    @Test
    fun `channel normalizes to stable unless beta`() {
        assertEquals("stable", ZCodeRuntimeConfigurable.normalizedChannel(null))
        assertEquals("stable", ZCodeRuntimeConfigurable.normalizedChannel(""))
        assertEquals("stable", ZCodeRuntimeConfigurable.normalizedChannel("beta "))
        assertEquals("stable", ZCodeRuntimeConfigurable.normalizedChannel("canary"))
        assertEquals("beta", ZCodeRuntimeConfigurable.normalizedChannel("beta"))
    }

    @Test
    fun `check status text per outcome`() {
        assertEquals(
            "当前运行时已是最新",
            ZCodeRuntimeConfigurable.checkStatusText(CheckResult(Outcome.UP_TO_DATE, null, null)),
        )
        // UP_TO_DATE 但带补充说明（验签失败回退 baseline 的形态）要透出原因
        assertEquals(
            "当前运行时已是最新（远端清单签名校验失败）",
            ZCodeRuntimeConfigurable.checkStatusText(CheckResult(Outcome.UP_TO_DATE, null, "远端清单签名校验失败")),
        )
        assertEquals(
            "本次检查已跳过：距上次检查不足 24 小时，已跳过",
            ZCodeRuntimeConfigurable.checkStatusText(CheckResult(Outcome.THROTTLED, null, "距上次检查不足 24 小时，已跳过")),
        )
        assertEquals(
            "远端运行时不兼容：原因",
            ZCodeRuntimeConfigurable.checkStatusText(CheckResult(Outcome.INCOMPATIBLE, "1.0.0", "原因")),
        )
        assertEquals(
            "更新已下载：0.2.0+x，重启 ZCode 后生效",
            ZCodeRuntimeConfigurable.checkStatusText(CheckResult(Outcome.DOWNLOADED, "0.2.0+x", "运行时更新 0.2.0+x 已下载，重启 ZCode 后生效")),
        )
        assertTrue(
            ZCodeRuntimeConfigurable.checkStatusText(CheckResult(Outcome.FAILED, null, "HTTP 404：stub"))
                .startsWith("检查失败："),
        )
        assertTrue(
            ZCodeRuntimeConfigurable.checkStatusText(CheckResult(Outcome.DISABLED, null, "已被关闭"))
                .startsWith("自动更新已禁用："),
        )
    }

    @Test
    fun `version text contains plugin runtime and node`() {
        val text = ZCodeRuntimeConfigurable.versionText("0.2.0+x", "24.14.0（/usr/bin/node）")
        assertTrue(text.contains("插件版本：0.1.0"), text)
        assertTrue(text.contains("运行时版本：0.2.0+x"), text)
        assertTrue(text.contains("Node：24.14.0（/usr/bin/node）"), text)
    }

    @Test
    fun `node description handles missing node`() {
        assertEquals("未检测到", ZCodeRuntimeConfigurable.nodeDescription(null))
        val node = NodeRuntime(Paths.get("node.exe"), 24, "24.14.0")
        assertEquals("24.14.0（node.exe）", ZCodeRuntimeConfigurable.nodeDescription(node))
    }
}
