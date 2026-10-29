package dev.zcode.ide.settings

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.Messages
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.UIUtil
import dev.zcode.ide.runtime.CheckResult
import dev.zcode.ide.runtime.NodeRuntime
import dev.zcode.ide.runtime.Outcome
import dev.zcode.ide.runtime.RuntimeManifest
import dev.zcode.ide.runtime.RuntimeProvisioner
import dev.zcode.ide.runtime.RuntimeSettings
import dev.zcode.ide.runtime.RuntimeUpdater
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextField

/**
 * 「ZCode 运行时」设置页（Settings → ZCode 运行时，id `dev.zcode.ide.runtime`）。
 *
 * 设置项与持久化键（方案 §6.7；优先级 env/系统属性 > 本页 > 默认，解析见 [RuntimeSettings.settingValue]）：
 * - 自动检查运行时更新 → [RuntimeSettings.KEY_AUTO_UPDATE]（bool，默认开；关 = RuntimeUpdater DISABLED）；
 * - 更新渠道 → [RuntimeSettings.KEY_CHANNEL]（stable / beta，默认 stable）；
 * - Manifest URL 覆盖 → [RuntimeSettings.KEY_MANIFEST_URL]（可空）；
 * - 镜像 Base URL 覆盖 → [RuntimeSettings.KEY_BASE_URL]（可空）。
 *
 * 被环境变量/系统属性显式覆盖的项在 UI 上只读标注「（已被环境变量覆盖，本次会话不生效）」，
 * 不做实时联动（配置读取发生在每个解析点）。
 * 版本探测（[NodeRuntime.find] 扫盘并起子进程）与「立即检查」「清理运行时缓存」均在后台线程执行，
 * 结果 invokeLater 刷新标签；页面关闭后回调触达前一律判空，不崩、不泄漏。
 */
class ZCodeRuntimeConfigurable : Configurable {

    private val log = Logger.getInstance("ZCodeIDE")

    // 控件引用：createComponent 之后才非空；disposeUIResources 置空（后台回调判空兜底）。
    private var autoUpdateCheckBox: JBCheckBox? = null
    private var channelCombo: ComboBox<String>? = null
    private var manifestUrlField: JTextField? = null
    private var baseUrlField: JTextField? = null
    private var versionLabel: JBLabel? = null
    private var statusLabel: JBLabel? = null

    /** 可被 env/系统属性覆盖的设置项 → 只读提示标签（reset 时刷新文案）。 */
    private val overrideHints = mutableListOf<OverrideHint>()

    private class OverrideHint(val propKey: String, val envKey: String, val label: JBLabel)

    override fun getDisplayName(): String = "ZCode 运行时"

    override fun createComponent(): JComponent {
        val checkbox = JBCheckBox(CHECKBOX_TEXT)
        val combo = ComboBox(arrayOf(CHANNEL_STABLE, CHANNEL_BETA))
        val manifestField = JTextField()
        val baseField = JTextField()
        val version = JBLabel(VERSION_PROBING_TEXT)
        val status = JBLabel(STATUS_IDLE)

        val autoHint = hintLabel()
        val channelHint = hintLabel()
        val manifestHint = hintLabel()
        val baseHint = hintLabel()
        overrideHints.clear()
        overrideHints.add(OverrideHint(RuntimeSettings.ENV_AUTO_UPDATE, RuntimeSettings.ENV_AUTO_UPDATE, autoHint))
        overrideHints.add(OverrideHint(RuntimeSettings.ENV_CHANNEL, RuntimeSettings.ENV_CHANNEL, channelHint))
        overrideHints.add(OverrideHint(RuntimeSettings.ENV_MANIFEST_URL, RuntimeSettings.ENV_MANIFEST_URL, manifestHint))
        // base URL 与 env 不同名：系统属性键是点分形式（设置页共用），env 是大写下划线形式。
        overrideHints.add(OverrideHint(RuntimeSettings.KEY_BASE_URL, RuntimeSettings.ENV_BASE_URL, baseHint))

        autoUpdateCheckBox = checkbox
        channelCombo = combo
        manifestUrlField = manifestField
        baseUrlField = baseField
        versionLabel = version
        statusLabel = status

        val panel = JPanel(GridBagLayout())
        val gbc = GridBagConstraints().apply {
            gridx = 0
            gridy = 0
            anchor = GridBagConstraints.WEST
            fill = GridBagConstraints.NONE
            insets = Insets(2, 0, 2, 0)
        }

        fun nextRow() {
            gbc.gridy++
            gbc.gridx = 0
        }

        fun addFullRow(component: JComponent, fill: Int = GridBagConstraints.NONE) {
            gbc.gridwidth = GridBagConstraints.REMAINDER
            gbc.fill = fill
            panel.add(component, gbc)
            nextRow()
        }

        fun addFieldRow(labelText: String, field: JComponent, hint: JBLabel) {
            gbc.gridwidth = 1
            gbc.fill = GridBagConstraints.NONE
            panel.add(JBLabel(labelText), gbc)
            gbc.gridx = 1
            gbc.weightx = 1.0
            gbc.fill = GridBagConstraints.HORIZONTAL
            panel.add(field, gbc)
            nextRow()
            addFullRow(hint)
            gbc.weightx = 0.0
        }

        addFullRow(checkbox)
        addFullRow(autoHint)
        addFieldRow("更新渠道：", combo, channelHint)
        addFieldRow("Manifest URL 覆盖：", manifestField, manifestHint)
        addFieldRow("镜像 Base URL 覆盖：", baseField, baseHint)
        addFullRow(JBLabel("当前版本：").apply { font = font.deriveFont(java.awt.Font.BOLD) })
        addFullRow(version, GridBagConstraints.NONE)
        addFullRow(status, GridBagConstraints.NONE)
        addFullRow(
            JPanel().apply {
                isOpaque = false
                add(JButton("立即检查").apply { addActionListener { checkNow() } })
                add(JButton("清理运行时缓存").apply { addActionListener { cleanupCache() } })
            },
        )

        reset()
        refreshVersionsInBackground()
        return panel
    }

    override fun isModified(): Boolean {
        val props = PropertiesComponent.getInstance()
        val checkbox = autoUpdateCheckBox ?: return false
        val combo = channelCombo ?: return false
        val manifestField = manifestUrlField ?: return false
        val baseField = baseUrlField ?: return false
        return checkbox.isSelected != props.getBoolean(RuntimeSettings.KEY_AUTO_UPDATE, true) ||
            normalizedChannel(combo.selectedItem as? String) !=
            normalizedChannel(RuntimeSettings.storedValue(RuntimeSettings.KEY_CHANNEL)) ||
            trimmedText(manifestField) != storedText(RuntimeSettings.KEY_MANIFEST_URL) ||
            trimmedText(baseField) != storedText(RuntimeSettings.KEY_BASE_URL)
    }

    override fun apply() {
        val props = PropertiesComponent.getInstance()
        autoUpdateCheckBox?.let { props.setValue(RuntimeSettings.KEY_AUTO_UPDATE, it.isSelected) }
        channelCombo?.let { combo ->
            props.setValue(RuntimeSettings.KEY_CHANNEL, normalizedChannel(combo.selectedItem as? String))
        }
        manifestUrlField?.let { writeOrUnset(RuntimeSettings.KEY_MANIFEST_URL, it.text) }
        baseUrlField?.let { writeOrUnset(RuntimeSettings.KEY_BASE_URL, it.text) }
    }

    override fun reset() {
        val props = PropertiesComponent.getInstance()
        autoUpdateCheckBox?.isSelected = props.getBoolean(RuntimeSettings.KEY_AUTO_UPDATE, true)
        channelCombo?.selectedItem = normalizedChannel(RuntimeSettings.storedValue(RuntimeSettings.KEY_CHANNEL))
        manifestUrlField?.text = storedText(RuntimeSettings.KEY_MANIFEST_URL)
        baseUrlField?.text = storedText(RuntimeSettings.KEY_BASE_URL)
        refreshOverrideHints()
    }

    override fun disposeUIResources() {
        autoUpdateCheckBox = null
        channelCombo = null
        manifestUrlField = null
        baseUrlField = null
        versionLabel = null
        statusLabel = null
        overrideHints.clear()
    }

    // ---- 动作 ----

    /**
     * 「立即检查」：pooled thread 强制检查（forceCheck 跳过 24h 节流；并发/开关由 RuntimeUpdater 防御），
     * 完成后 invokeLater 刷新检查状态与版本标签。
     */
    private fun checkNow() {
        statusLabel?.text = STATUS_CHECKING
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = runCatching { RuntimeUpdater.checkInBackground(status = {}, forceCheck = true) }
                .onFailure { log.warn("Manual ZCode runtime update check failed", it) }
                .getOrNull()
            ApplicationManager.getApplication().invokeLater {
                statusLabel?.text = result?.let(::checkStatusText) ?: "检查异常终止，详见 IDE 日志（ZCodeIDE）"
                refreshVersionsInBackground()
            }
        }
    }

    /**
     * 「清理运行时缓存」：确认对话框（保留 current/pending/上一版）→ 后台
     * [RuntimeProvisioner.cleanup]（keepPreviousOne = true 保留回滚用上一版；.part 仅删超 7 天的）
     * → 完成后刷新版本标签。
     */
    private fun cleanupCache() {
        val answer = Messages.showYesNoDialog(
            "将保留当前版本、待生效更新（pending）与上一版本（供回滚），" +
                "删除其余版本目录与超过 7 天的未完成下载缓存（.part）。\n\n是否继续？",
            "清理运行时缓存",
            Messages.getQuestionIcon(),
        )
        if (answer != Messages.YES) return
        statusLabel?.text = "正在清理运行时缓存…"
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching {
                RuntimeProvisioner.cleanup(keepCurrent = true, keepPending = true, keepPreviousOne = true)
            }.onFailure { log.warn("ZCode runtime cache cleanup failed", it) }
            ApplicationManager.getApplication().invokeLater {
                statusLabel?.text = "清理完成（保留当前/pending/上一版；.part 仅删除超过 7 天的）"
                refreshVersionsInBackground()
            }
        }
    }

    /** 后台探测运行时/Node 版本（[NodeRuntime.find] 会扫盘并起子进程，不可在 EDT），完成后刷新标签。 */
    private fun refreshVersionsInBackground() {
        versionLabel?.text = VERSION_PROBING_TEXT
        ApplicationManager.getApplication().executeOnPooledThread {
            val runtimeVersion = runCatching { RuntimeProvisioner.currentVersion() }.getOrNull() ?: "未安装"
            val node = runCatching { NodeRuntime.find() }.getOrNull()
            ApplicationManager.getApplication().invokeLater {
                versionLabel?.text = versionText(runtimeVersion, nodeDescription(node))
            }
        }
    }

    // ---- UI 辅助 ----

    private fun hintLabel(): JBLabel =
        JBLabel(OVERRIDE_HINT_TEXT, UIUtil.ComponentStyle.SMALL).apply { foreground = JBColor.GRAY }

    private fun refreshOverrideHints() {
        for (hint in overrideHints) {
            hint.label.text = if (isOverridden(hint.propKey, hint.envKey)) OVERRIDE_HINT_TEXT else ""
        }
    }

    /** env/系统属性任一显式配置（trim 后非空）即视为覆盖。 */
    private fun isOverridden(propKey: String, envKey: String): Boolean =
        System.getProperty(propKey)?.trim()?.takeIf(String::isNotBlank) != null ||
            System.getenv(envKey)?.trim()?.takeIf(String::isNotBlank) != null

    /** 写入设置页持久化值；空串 = 撤销覆盖（unsetValue，而不是存一个空值）。 */
    private fun writeOrUnset(key: String, raw: String) {
        val value = raw.trim()
        if (value.isEmpty()) {
            PropertiesComponent.getInstance().unsetValue(key)
        } else {
            PropertiesComponent.getInstance().setValue(key, value)
        }
    }

    private fun trimmedText(field: JTextField): String = field.text.trim()

    private fun storedText(key: String): String = RuntimeSettings.storedValue(key) ?: ""

    companion object {
        internal const val CHANNEL_STABLE = "stable"
        internal const val CHANNEL_BETA = "beta"

        private const val CHECKBOX_TEXT = "自动检查运行时更新"
        private const val STATUS_IDLE = "尚未执行手动检查"
        private const val STATUS_CHECKING = "正在检查运行时更新…"
        private const val VERSION_PROBING_TEXT = "插件版本：…　运行时版本：探测中…　Node：探测中…"
        private const val OVERRIDE_HINT_TEXT = "（已被环境变量覆盖，本次会话不生效）"

        /** 渠道值归一化：仅接受 beta，其余（null/空白/垃圾值）一律 stable。 */
        internal fun normalizedChannel(raw: String?): String = if (raw == CHANNEL_BETA) CHANNEL_BETA else CHANNEL_STABLE

        /** 检查结果 → 设置页状态文案（纯函数，可测）。 */
        internal fun checkStatusText(result: CheckResult): String = when (result.outcome) {
            Outcome.UP_TO_DATE -> result.message?.let { "当前运行时已是最新（$it）" } ?: "当前运行时已是最新"
            Outcome.THROTTLED -> "本次检查已跳过：${result.message ?: "节流窗口内已有检查"}"
            Outcome.INCOMPATIBLE -> "远端运行时不兼容：${result.message ?: "未知原因"}"
            Outcome.DOWNLOADED -> "更新已下载：${result.runtimeVersion ?: result.message ?: ""}，重启 ZCode 后生效"
            Outcome.FAILED -> "检查失败：${result.message ?: "未知原因"}"
            Outcome.DISABLED -> "自动更新已禁用：${result.message ?: ""}"
        }

        /** 版本行文案（纯函数，可测）：插件版本为常量，运行时/Node 由后台探测后传入。 */
        internal fun versionText(runtimeVersion: String, nodeDescription: String): String =
            "插件版本：${RuntimeManifest.PLUGIN_VERSION}　运行时版本：$runtimeVersion　Node：$nodeDescription"

        /** Node 探测结果 → 显示文案（纯函数，可测）。 */
        internal fun nodeDescription(node: NodeRuntime?): String =
            node?.let { "${it.version}（${it.path}）" } ?: "未检测到"
    }
}
