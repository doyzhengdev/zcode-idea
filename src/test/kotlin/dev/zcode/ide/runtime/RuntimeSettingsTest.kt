package dev.zcode.ide.runtime

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import java.util.concurrent.ConcurrentHashMap

/**
 * 运行期设置覆盖链（方案 §6.7）：env/系统属性 > 设置页（PropertiesComponent）> 默认。
 *
 * platform 依赖不进单测：设置页层统一走 [RuntimeSettings.storedValue]（默认 PropertiesComponent），
 * 这里注入内存 fake 验证三分支与优先级；env 无法在 JVM 单测里安全改写，
 * 与系统属性同属一条代码路径，用系统属性代表「env/系统属性」层。
 */
class RuntimeSettingsTest {

    private val stored = ConcurrentHashMap<String, String>()

    private val defaultStoredValue = RuntimeSettings.storedValue

    @AfterEach
    fun restoreDefaults() {
        RuntimeSettings.storedValue = defaultStoredValue
        System.clearProperty(PROP_KEY)
        System.clearProperty(RuntimeSettings.ENV_MANIFEST_URL)
        System.clearProperty(RuntimeSettings.ENV_CHANNEL)
        System.clearProperty(RuntimeSettings.ENV_AUTO_UPDATE)
        System.clearProperty(RuntimeSettings.KEY_BASE_URL)
        stored.clear()
    }

    // ---- settingValue：三分支与优先级 ----

    @Test
    fun `system property wins over stored value`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[STORED_KEY] = "from-settings"
        System.setProperty(PROP_KEY, "from-property")

        assertEquals("from-property", RuntimeSettings.settingValue(PROP_KEY, ENV_KEY, STORED_KEY))
    }

    @Test
    fun `stored value used when property and env absent`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[STORED_KEY] = "from-settings"

        assertEquals("from-settings", RuntimeSettings.settingValue(PROP_KEY, ENV_KEY, STORED_KEY))
    }

    @Test
    fun `null when nothing configured`() {
        RuntimeSettings.storedValue = { stored[it] }

        assertNull(RuntimeSettings.settingValue(PROP_KEY, ENV_KEY, STORED_KEY))
    }

    @Test
    fun `blank property falls through to stored value`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[STORED_KEY] = "from-settings"
        System.setProperty(PROP_KEY, "   ")

        assertEquals("from-settings", RuntimeSettings.settingValue(PROP_KEY, ENV_KEY, STORED_KEY))
    }

    @Test
    fun `all layers are trimmed`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[STORED_KEY] = "  padded  "

        assertEquals("padded", RuntimeSettings.settingValue(PROP_KEY, ENV_KEY, STORED_KEY))
    }

    @Test
    fun `stored key defaults to property key`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[PROP_KEY] = "from-settings"
        System.clearProperty(PROP_KEY)

        assertEquals("from-settings", RuntimeSettings.settingValue(PROP_KEY, ENV_KEY))
    }

    // ---- RuntimeUpdater.autoUpdateDisabledReason：开关链 ----

    @Test
    fun `auto update disabled via system property zero`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[RuntimeSettings.KEY_AUTO_UPDATE] = "true"
        System.setProperty(RuntimeSettings.ENV_AUTO_UPDATE, "0")

        assertNotNull(RuntimeUpdater.autoUpdateDisabledReason())
    }

    @Test
    fun `explicit enable via system property overrides settings page disable`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[RuntimeSettings.KEY_AUTO_UPDATE] = "false"
        System.setProperty(RuntimeSettings.ENV_AUTO_UPDATE, "1")

        assertNull(RuntimeUpdater.autoUpdateDisabledReason())
    }

    @Test
    fun `auto update disabled via settings page false`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[RuntimeSettings.KEY_AUTO_UPDATE] = "false"

        assertNotNull(RuntimeUpdater.autoUpdateDisabledReason())
    }

    @Test
    fun `auto update enabled by default and by settings page true`() {
        RuntimeSettings.storedValue = { stored[it] }

        assertNull(RuntimeUpdater.autoUpdateDisabledReason())

        stored[RuntimeSettings.KEY_AUTO_UPDATE] = "true"
        assertNull(RuntimeUpdater.autoUpdateDisabledReason())
    }

    // ---- RuntimeUpdater.manifestUrl：地址与渠道链 ----

    @Test
    fun `manifest url property overrides settings page`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[RuntimeSettings.KEY_MANIFEST_URL] = "https://settings.example.com/manifest.json"
        System.setProperty(RuntimeSettings.ENV_MANIFEST_URL, "https://property.example.com/manifest.json")

        assertEquals("https://property.example.com/manifest.json", RuntimeUpdater.manifestUrl())
    }

    @Test
    fun `manifest url from settings page when property absent`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[RuntimeSettings.KEY_MANIFEST_URL] = "https://settings.example.com/manifest.json"

        assertEquals("https://settings.example.com/manifest.json", RuntimeUpdater.manifestUrl())
    }

    @Test
    fun `channel from settings page builds default url`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[RuntimeSettings.KEY_CHANNEL] = "beta"

        assertEquals("https://cdn.example.com/zcode-ide/runtime/beta/manifest.json", RuntimeUpdater.manifestUrl())
    }

    @Test
    fun `channel property overrides settings page`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[RuntimeSettings.KEY_CHANNEL] = "stable"
        System.setProperty(RuntimeSettings.ENV_CHANNEL, "beta")

        assertEquals("https://cdn.example.com/zcode-ide/runtime/beta/manifest.json", RuntimeUpdater.manifestUrl())
    }

    @Test
    fun `manifest url defaults to stable channel`() {
        RuntimeSettings.storedValue = { stored[it] }

        assertEquals("https://cdn.example.com/zcode-ide/runtime/stable/manifest.json", RuntimeUpdater.manifestUrl())
    }

    // ---- RuntimeProvisioner.baseUrl：下载源链 ----

    @Test
    fun `base url from settings page with trailing slash normalization`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[RuntimeSettings.KEY_BASE_URL] = "https://mirror.example.com/prefix"

        assertEquals("https://mirror.example.com/prefix/", RuntimeProvisioner.baseUrl())
    }

    @Test
    fun `base url property overrides settings page`() {
        RuntimeSettings.storedValue = { stored[it] }
        stored[RuntimeSettings.KEY_BASE_URL] = "https://mirror.example.com/"
        System.setProperty(RuntimeSettings.KEY_BASE_URL, "https://prop.example.com")

        assertEquals("https://prop.example.com/", RuntimeProvisioner.baseUrl())
    }

    @Test
    fun `base url defaults to placeholder domain`() {
        RuntimeSettings.storedValue = { stored[it] }

        assertEquals("https://cdn.example.com/", RuntimeProvisioner.baseUrl())
    }

    companion object {
        private const val PROP_KEY = "test.zcode.runtime.setting.prop"
        private const val ENV_KEY = "ZCODE_TEST_NO_SUCH_ENV"
        private const val STORED_KEY = "test.zcode.runtime.setting.stored"
    }
}
