# 2026-10-29 · 工具窗口声明 DumbAware，修复索引期间面板不可用

- **范围**：插件 Kotlin（ToolWindowFactory + 三个启动活动）
- **触发**：bug —— IDE 建索引期间 ZCode 面板不可用，同期 CodeBuddy 面板正常
- **提交**：working tree

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/main/kotlin/dev/zcode/ide/ui/ZCodeToolWindowFactory.kt` | 修改 | `ToolWindowFactory` 之外实现 `DumbAware`，并写明平台判定链路 |
| `src/main/kotlin/dev/zcode/ide/remote/RemoteControlAutoStart.kt` | 修改 | `RemoteControlStartupActivity` 实现 `StartupActivity.DumbAware` |
| `src/main/kotlin/dev/zcode/ide/startup/RuntimeUpdateCheckActivity.kt` | 修改 | 同上 |
| `src/main/kotlin/dev/zcode/ide/startup/PromoteZCodeActionsActivity.kt` | 修改 | `ProjectActivity` 之外实现 `com.intellij.openapi.project.DumbAware` |

## 为什么改

### 根因

不是 Node/JCEF 在索引期起不来，而是**平台把整个工具窗口内容换成了占位组件**。链路（反编译 IDEA 2026.2.2）：

1. `com.intellij.toolWindow.ToolWindowSetInitializerKt.beanToTask(...)` 把 plugin.xml 的 `<toolWindow>` 转成注册任务，其中
   ```java
   boolean canWorkInDumbMode = DumbService.Companion.isDumbAware(factory);
   ```
2. `com.intellij.openapi.project.DumbService$Companion.isDumbAware(Object o)`：
   ```java
   if (!force && !Registry.is("ide.dumb.mode.check.awareness")) return true;
   return o instanceof PossiblyDumbAware ? ((PossiblyDumbAware)o).isDumbAware()
                                         : o instanceof DumbAware;
   ```
3. `com.intellij.openapi.wm.impl.ToolWindowImpl.createContentManager()`：
   ```java
   if (!this.dumbAware) {
       decoratorChild = DumbService.getInstance(project).wrapGently(decoratorChild, parentDisposable);
   }
   ```
4. `DumbServiceImpl.wrapGently()` 用 `DumbUnawareHider` 包住整个 content，`setContentVisible(!isDumb())`，并订阅 `DumbService.DUMB_MODE` 切换可见性。
5. `DumbUnawareHider` 的 emptyText 是 `empty.text.this.view.is.not.available.until.indices.are.built`，即界面上的 "This view is not available until indexes are built"。

所以现象是"整块内容消失、只剩空状态文案"，索引结束自动恢复，而不是报错。

### 对照 CodeBuddy（`coding-copilot-jetbrains` 4.12.41911495）

反编译 `lib/instrumented-code-icc-extensions-4.12.41911495.jar`：

- `com.tencent.code.intel.apibridge.toolwindow.ToolWindowHelper`：
  `public class ToolWindowHelper implements ToolWindowFactory, DumbAware`
- `NodeProjectStartUpActivity` / `StartupLSAgent`：`implements StartupActivity, StartupActivity.DumbAware`
- 整个 jar 里 **没有任何** `DumbService` / `DumbMode` / `IndexingActivity` / `IndexNotReady` 引用。

即它没有"等索引完成再启动"的技巧，只是声明了"我不依赖索引"。这也验证了修复方向：**声明 dumb-aware，而不是加等待逻辑**。

### 为什么我们可以在索引期开放面板

`IdeBridge` 只用 `VirtualFile`、`ProjectView`、`FileEditorManager`、`LocalFileSystem`、文件对话框；`ZCodePanel` 只做 JCEF 与启动 Node 进程。都不读 PSI 与索引，索引期调用不会抛 `IndexNotReadyException`。

## 行为变化

- 索引期间（dumb mode）ZCode 工具窗口正常显示，Node server 与页面照常启动；不再出现 "This view is not available until indexes are built"。
- 三个启动活动改为索引期即执行：远控自动恢复、运行时更新检查、右键菜单提升不再被压到索引结束之后。
- 桌面端与独立 Web 端零影响（不涉及 `packages/`）。

## 验证

- `JAVA_HOME=<jdk21> ./gradlew buildPlugin --console=plain` → `BUILD SUCCESSFUL in 14s`。
- 产物校验：`javap` 直接读 zip 内 `zcode-ide-0.1.0.jar`，确认
  `ZCodeToolWindowFactory implements ToolWindowFactory, DumbAware`、
  `PromoteZCodeActionsActivity implements ProjectActivity, DumbAware`、
  两个启动活动 `implements StartupActivity, StartupActivity$DumbAware`。
- 安装态校验：替换 `plugins/zcode-ide` 后 `javap` 读安装目录 jar，同样带 `DumbAware`；重启日志出现 `ZCode webview loaded`。
- **索引期实机验证（用户确认）**：关闭 IDE 后删除 `%LOCALAPPDATA%\JetBrains\IntelliJIdea2026.2\index` 并重启，触发冷索引（`Scanning completed ... Number of scanned files: 310242; number of files for indexing: 304042`，`IndexUpdateRunner Using 15 workers`）。索引进行中 ZCode 面板正常显示并可用，**不再出现 "This view is not available until indexes are built"**。
- 排查记录：用"新建大量文件 → 等文件监听触发索引"的方式在本机不可靠（VFS 未及时刷新，`SetForegroundWindow` 也拿不到前台），最终用"删索引目录 + 重启"制造冷索引。

## 风险 / 后续

- 索引期同时启动 Node server + JCEF 会与索引争 CPU/IO，首次打开比"索引完再开"更慢。
- `ide.dumb.mode.check.awareness` 这个 Registry 开关为 false 时，平台对所有工具窗都按 dumb-aware 处理；排查该问题时先确认它处于默认开启状态。
- 页面/桥将来若新增依赖符号索引的能力，需要在能力内部自行做 dumb mode 降级，不能依赖工具窗被隐藏来兜底。
- 验证过程中发现 `vendor/ZCode/node_modules` 缺失导致 dev 布局 server 启动报 `ERR_MODULE_NOT_FOUND: yauzl`（与本次代码改动无关，属本地依赖树被清理），已用 `pnpm install --frozen-lockfile` 恢复。

## 相关

- `development/INVARIANTS.md` 第 25 条（新增）
- `architecture/IDE-VS-DESKTOP.md` §7 索引期可用性
