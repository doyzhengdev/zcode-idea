# IDE 插件 vs 官方桌面客户端：功能差异全清单

> 一句话：**同一套 UI、同一套 Agent、同一个 `~/.zcode`，只把外壳从 Electron 换成 IDE**。
> 本文穷举两者的功能差异，逐项标注类型：
>
> - 【新增】桌面端没有、IDE 插件新增的功能
> - 【删除】桌面端有、IDE 里入口被移除
> - 【修改】两边都有，但行为/范围/实现路径不同
> - 【不支持】桌面端有、IDE 明确不提供（底层能力缺失，不是隐藏）
> - 【相同】明确说明未改动，避免误判
>
> 判定依据：`packages/web-ide/src/idePlatform.ts`（能力实现）、`packages/ui/src/lib/ideHost.ts`（UI 门控）、`packages/web-ide/src/styles.css`（纯视觉隐藏）。

## 0. 差异总览

| 区域 | 变化幅度 | 重点 |
|---|---|---|
| 左侧栏 | **最大** | 删掉新建任务/项目区/置顶区/分组视图/搜索/视图切换/自动化/插件市场/项目创建入口；新增侧栏折叠把手；任务范围锁定当前项目并固定 timeline |
| 头部与顶部浮层 | 大 | 只保留一个「新建对话 ➕」；帮助、终端、右侧面板、前进/后退、顶部侧栏开关、侧栏收起后浮出的新建对话全部移除，收起态也不再预留左侧留白；草稿上方的项目/分支切换移除 |
| 草稿与新建对话 | 中 | 模型改用最近使用并每次进入重新播种；新建任务不再强制带 `projectId`；新建项目对话框入口删除 |
| 对话与消息 | 中 | 新增选区发送；右键引用可进活动会话；消息链接带行号列号；running 状态改由 sessions-index 自愈 |
| 文件与目录 | 中 | 四类文件源统一进 IDE 编辑器并定位到行；目录定位到项目树；媒体仍内置预览 |
| 设置 / MCP / 记忆 | 小 | 记忆详情对 IDE 开放；MCP 转发本机 server；导出日志与自动更新移除 |
| 窗口与外壳 | 中 | 窗口控件/托盘/菜单/剪贴板/更新由 IDE 承担；通知改为 IDE 通知 |
| 运行时与数据 | 中 | 单 server + 固定端口 + URL 传项目；新增懒启动、`Ctrl+W` 保护、Node 自动供给、多项目窗口 |
| 网络与容器 | 部分支持 | 远程工作区、Docker/WSL/SSH、Computer Use、内置浏览器不支持；**手机 Web 远控已支持**（复用官方 relay device 桥） |

## 1. 左侧栏（改动最多）

### 1.1 布局与开关

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 侧栏顶部拖拽条 | 【修改】 | 48px 高的 `[app-region:drag]` 空白，用于拖动 Electron 窗口 | 缩为 **8px**（`h-2`），不留拖拽区 | `project-sidebar/index.tsx` 的 `ideHost` 分支 |
| 侧栏收起/展开按钮 | 【新增】 | 由顶部浮层 `DesktopTopOverlay` 的 `SidebarToggleIcon` 控制 | IDE 没有顶部浮层，新增**侧栏右缘中点的折叠把手**：22×48px、圆角带阴影、`z-30`；展开时显示 `PanelLeftClose`，收起后把手停在左边缘显示 `PanelLeftOpen`，位置跟随 `--workspace-sidebar-panel-width` | `WorkspaceShellLayout.tsx`，`data-testid="ide-sidebar-toggle"`，`aria-label=workspaceSidebar.toggleSidebar` |
| 侧栏默认视图 | 【修改】 | 三选一：按项目 / 分组 / 最近更新，偏好持久化 | 固定为**最近更新（timeline）**；`ideHost` 分支直接渲染 timeline，不读取 `view` | `project-sidebar/index.tsx` |

### 1.2 顶部导航

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 新建任务按钮组 | 【删除】 | 「新建任务」整行 + 快捷键提示 | 整行隐藏；新建入口统一由头部右上角 ➕ 承担，侧栏顶部不再重复 | `web-ide/src/styles.css` 隐藏 `[data-testid="task-new-button"]` |
| 自动化入口 | 【删除】 | 「定时任务/自动化」按钮 | 入口隐藏（功能页面本身仍在，但无入口） | `web-ide/src/styles.css` 隐藏 `[data-testid="automations-open"]` |
| 插件市场入口 | 【删除】 | 侧栏「插件」按钮 | 入口隐藏 | CSS 隐藏 `[data-testid="plugin-store-sidebar-open"]` |
| 远程设备导航 | 【部分支持】 | 手机远控时显示当前电脑/设备切换 | 远控已可用；桥向手机提供 **ZCode 里添加的全部项目**（来自 server `projectService`），手机端可在项目间切换；设备行显示当前设备，跨设备切换不提供 | `ide-remote-bridge` 的 `readProjectWorkspaces`；workspaceKey 必须用 server 原始写法（见 [`INVARIANTS.md`](../development/INVARIANTS.md) 第 23 条） |

### 1.3 列表头

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 列表标题 | 【相同】 | 「任务」标题 | 保留 | `ProjectSidebarListHeader` |
| 搜索 / 命令中心入口 | 【删除】 | 搜索图标，打开 Command Center | 图标隐藏；命令中心页面本身仍在，但侧栏没有入口 | CSS 隐藏 `[data-testid="sidebar-search-open"]` |
| 视图切换菜单 | 【删除】 | 下拉选择「按项目 / 分组 / 最近更新」 | 菜单隐藏；视图锁定 timeline | CSS 隐藏 `[data-testid="sidebar-view-menu"]` |

### 1.4 任务列表

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 按项目分组视图 | 【删除】 | 每个项目一个可展开节点，可置顶、拖拽排序、查看项目文件、编辑/删除项目 | IDE 分支不渲染 `ProjectSections` / `SortableProjects` | `project-sidebar/index.tsx` |
| 置顶任务区 | 【删除】 | 列表顶部固定显示 pinned 任务 | 不渲染 `ProjectTaskRows kind="pinned"` | 同上 |
| 任务分组（task groups）视图 | 【删除】 | 按分组展示，可在分组内新建任务 | 不渲染 `TaskGroupedView` | 同上 |
| home-only 工作区切换 | 【删除】 | 远端/远控场景下的工作区切换列表 | 不渲染 `HomeOnlyWorkspaceRows` | 同上 |
| 任务可见范围 | 【修改】 | 所有项目的任务 + 未归属项目的散会话 | **只显示当前工作区所属项目**的未归档任务；散会话不显示 | `ideTasks` 过滤 `task.projectId === ideProject.id` 且 `!task.archived` |
| 任务排序 | 【修改】 | 按当前视图规则（项目内排序 / 分组排序） | 固定按最近活动（`compareProjectTaskRows(..., "timeline")`） | `ideTasks` |
| 项目路径匹配 | 【新增】 | 严格相等匹配项目根 | IDE 做**路径归一化**（反斜杠转正斜杠、去尾斜杠、小写），并接受工作区是项目根的子目录 | `normalizeProjectPath` + `matchesRoot` |
| 加载瞬间防闪烁 | 【新增】 | 无此问题（侧栏本来显示全部项目） | 项目列表未到达时**保持空列表**，避免闪出其它项目的任务；项目已加载但路径匹配失败时回退全量，避免整栏空白 | `ideTasks` 的 `hasProjects` 守卫 |
| 侧栏底部 | 【修改】 | 用户/登录/设置/主题/语言/升级/banner，外加**界面缩放子菜单**与 **Web 远控触发按钮** | 用户/登录/设置/主题/语言/升级/banner 保留；界面缩放子菜单不渲染；远控按钮在 IDE 也渲染（`isDesktop \|\| isIdeHost()`） | `WorkspaceSidebarFooter` |

### 1.5 项目创建与编辑

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 「添加项目」入口 | 【删除】 | 项目区底部按钮，打开 `ProjectCreation` 对话框 | IDE 不渲染项目区，没有入口 | `project-sidebar/index.tsx` |
| 项目编辑/删除 | 【删除】 | 项目节点右键菜单 | 无入口（代码仍在，但不可达） | 同上 |
| 项目创建 | 【新增】 | 用户手动创建 | 启动时由 web-ide **自动创建/绑定当前项目**（`saveProject`），绕开 Web 模式不可用的对话框 | `web-ide/src/main.tsx` |

## 2. 头部与顶部浮层

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 右上角「新建对话 ➕」 | 【新增】 | 头部无此按钮（新建入口在侧栏） | 新增图标按钮；**侧栏收起时先展开侧栏再新建**，保证用户能看到新会话 | `WorkspaceHeaderActionSection.tsx`，`data-testid="ide-header-new-task"` |
| 帮助菜单 | 【删除】 | 帮助图标 | 不渲染 | `WorkspaceHeaderActionSection` 的 `ideHost` 分支 |
| 终端开关 | 【删除】 | 终端切换按钮 | 不渲染 | 同上 |
| 右侧面板开关（side pane） | 【删除】 | 切换右侧面板 | 不渲染 | 同上 |
| 任务前进/后退 | 【删除】 | 顶部浮层中的导航按钮 | 不渲染 | `web-ide/src/styles.css` 隐藏整个浮层根节点（`DesktopTopOverlay` 保持上游原状） |
| 顶部浮层侧栏开关 | 【删除】 | `SidebarToggleIcon` | 由 1.1 的侧栏折叠把手替代；浮层整块隐藏 | `web-ide/src/styles.css` + `WorkspaceShellLayout` |
| 顶部浮层「新建对话 ➕」 | 【删除】 | 侧栏收起时在左上角浮出，作为新建入口 | 随浮层整块隐藏；新建入口只保留头部右上角 ➕ | `web-ide/src/styles.css` |
| 侧栏收起时的顶部左侧留白 | 【删除】 | header 内层 / Side Pane tab 栏加 `pl-38`（Mac 为 `pl-58` 等）避让浮层按钮 | 浮层已不存在，CSS 把 `pl-38`/`pl-44` 清零，标题贴左 | `web-ide/src/styles.css` |
| 窗口控件（最小化/最大化/关闭） | 【不支持】 | Electron 窗口控件 | 由 IDE 窗口系统提供，插件不渲染 | `isDesktop=false`，`showWindowControls` 不成立 |
| 草稿上方的项目/分支切换 | 【删除】 | `ProjectComposerMenu` | `draftComposerHeader` 返回 `undefined` | `WorkspaceShellLayout.tsx` 的 `ideHost` 分支 |
| 窗口标题栏主题 | 【不支持】 | `setTitleBarTheme` 同步标题栏 | 空实现（IDE 没有该区域） | `idePlatform.ts` |

## 3. 草稿与新建对话

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 新建对话的模型来源 | 【修改】 | 读取当前 scope 的最近使用模型 | 修复了"新建任务入口不带 `projectId` 导致回落默认模型"：写入时额外存一份 workspace 级副本，读取时回退到它 | `lib/composerRecent.ts` |
| 进入空草稿时的模型播种 | 【修改】 | 只在状态未初始化时播种 | 每次进入空「新建任务」按 Recent **重新播种一次**，用 `scopeKey` 做闸门，用户手动改选不被覆盖 | `v4/composer/useDraftConfigControl.ts` |
| 新建任务的附件身份 | 【修改】 | 远程附件场景重新走远程导航 | 同一工作区已有远端身份时直接沿用，跳过远程导航；避免插件缺少 `openRemoteProjectWorkspace` 时抛错导致"点新建没反应" | `root/useRootWorkspaceActions.ts` |
| 新建项目对话框 | 【删除】 | 完整的项目创建/设备选择对话框 | 入口删除（见 1.5） | 无入口 |

## 4. 对话与消息

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 编辑器选区发送到输入框 | 【新增】 | 无 | 编辑器右键「添加选区到 ZCode 对话」，只发 `完整路径#Lx-Ly`，不发选中原文 | Kotlin `SendSelectionToZCodeComposerAction` → `ideContextPush.ts` 的 `selectionToInput` |
| 右键文件引用进活动会话 | 【修改】 | 外部插入请求只允许进入新建草稿（`sessionId === null`） | 放开该限制，活动会话的输入框也能插入文件引用 | `v4/SessionPane.tsx` |
| 消息链接定位到行/列 | 【修改】 | 解析出行号后只能传给内置查看器 | 行号/列号沿 `MessageFileLinkTarget` → `FileCodeViewerSource` → `openExternalFile(path, {line, column})` 传到 IDE 编辑器 | `components/ai-elements/message.tsx`、`lib/codeViewer.ts`、`shared/platform.ts` |
| 侧栏运行状态（running 图标） | 【修改】 | 由 `window-controller` 通道推送 activity | IDE 没有该通道，改由 sessions-index 投影；订阅静默失效时监听 `workspace_task_list_changed` 重订（3 秒限流，按事件所属 scope） | `v4/useWorkspaceSessionsIndexItems.ts`、`v4/sessionsIndexStore.ts` |
| 归档 / 置顶 / 已读 | 【修改】 | 经 `window-controller` 调用 | 代理屏蔽 `windowControllerService`，改走 `zcodeTaskService`；用户可见行为相同 | `web-ide/src/main.tsx` 的 `forIdeHost` |

## 5. 文件与目录

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 打开对话里的文件 | 【修改】 | 内置代码查看器 | **IDE 编辑器**：`file` / `patch` / `multi-file-diff` / `text` 四类源统一进编辑器 | `useAppPanels.handleOpenCodeViewer` → `lib/ideFileOpen.ts` |
| 打开变更文件行 / 工具调用行 / 预览卡片 | 【修改】 | 内置查看器 | 同上，规则只在 `useAppPanels` 一个汇合点 | 同上 |
| 面板内文件树点文件 | 【修改】 | 继续在面板内翻文件 | 改投 IDE 编辑器，避免用户被带进内置文件树后出不来 | `useAppPanels.handleNavigateFileManager` |
| 点目录链接 | 【修改】 | 打开内置文件树 | 定位到 **IDE 项目树**（`selectInProjectView`） | `useAppPanels.handleOpenFileManager` |
| 工作区外的临时目录/附件 | 【相同】 | 内置文件树 | 项目树里没有节点，仍回落到内置文件树 | 同上（`temporaryExternalDirectory` 判断） |
| 行号/列号定位 | 【新增】 | 查看器内滚动定位 | IDE 编辑器直接跳到目标行/列 | `platform.openExternalFile(path, location)` |
| 媒体/PDF/PPT/图片/审查意见 | 【相同】 | 内置预览 | 仍走内置预览（IDE 里只会变成二进制） | `ideFileOpen.ts` 的准入集合 |

## 6. 设置 / MCP / 记忆

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 记忆详情入口 | 【修改】 | 上游写死 `isDesktop` 才可读 | 改为 `isDesktop \|\| isIdeHost()`，IDE 也能查看本机记忆 | `SettingsPage.tsx`（唯一保留的上游逻辑改动） |
| MCP 用户目录读写 | 【修改】 | Electron main 进程读写 `~/.zcode/cli/config.json` | platform 转发到本机 server 的 `mcpSyncService`；未注入时安全降级 | `web-ide/src/idePlatform.ts` |
| 记忆数据位置 | 【相同】 | `~/.zcode/cli/memories/projects/<slug>-<hash>/memory` | 同一位置，按 workspace 路径分目录；换目录等于换一套记忆 | 官方实现 |
| 导出日志 | 【删除】 | 设置里导出应用日志 | `notSupported("导出日志")` | `idePlatform.ts` |
| 自动更新设置 | 【删除】 | 检查更新、下载、重启安装 | 全部空实现/禁用，由 IDE 插件管理 | `idePlatform.ts` |
| 界面缩放 | 【删除】 | 账户菜单中的「界面缩放」子菜单（放大/缩小/实际大小） | `isDesktop` 为 false，子菜单不渲染；缩放由 IDE 自己负责 | `WorkspaceSidebarFooter.tsx` |

## 7. 窗口与外壳

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 系统通知 | 【修改】 | Electron 系统通知 | IDE 通知（`NotificationGroup "ZCodeIDE"`） | `IdeBridge.notify` |
| 窗口最小化/最大化/关闭/全屏 | 【不支持】 | Electron `BrowserWindow` | IDE 窗口系统 | 不实现 |
| 系统托盘、任务栏角标 | 【不支持】 | Electron 托盘 | 无 | 不实现 |
| 应用菜单、全局快捷键 | 【不支持】 | Electron 菜单/全局快捷键 | IDE 菜单与 keymap | 不实现 |
| 剪贴板、电源管理 | 【不支持】 | Electron API | 浏览器内核 / IDE | 不实现 |
| 多窗口标签同步、未读数同步 | 【不支持】 | `syncWindowTabs` 等 IPC | 每个项目窗口独立面板，不跨窗口同步 | `idePlatform.ts` 空实现 |
| 窗口截图 | 【不支持】 | `captureWindowScreenshot` | 返回 `null` | `idePlatform.ts` |
| Chrome 浏览器数据导入 | 【不支持】 | 导入 cookies/localStorage | 返回 `chrome_import_not_supported` | `idePlatform.ts` |
| 打开外部链接 / 文件管理器 | 【相同】 | 系统浏览器 / 资源管理器 | 经 IDE 转发到系统，行为一致 | `IdeBridge.openExternal` / `openInFileManager` |
| 页面内鼠标指针形状 | 【修改】 | Chromium 原生决定（文本 I-beam、链接 hand、分割线 `ew-resize`） | JCEF 在 out-of-process（remote-mode）下走 OSR 合成但不转发 `RenderHandler_OnCursorChange`，原生光标回调丢失；改为页面按 40ms 采样 `getComputedStyle().cursor` 回传、面板映射成 AWT 光标。覆盖常用形状（text / pointer / move / resize / crosshair / wait），未列出的回退默认箭头，鼠标静止时 DOM 变化不刷新 | `src/main/kotlin/dev/zcode/ide/ui/ZCodePanel.kt`，详见 [`changes/2026-10-29-4-ide-cursor-sync.md`](../changes/2026-10-29-4-ide-cursor-sync.md) |

## 8. 运行时与数据

| 条目 | 类型 | 桌面客户端 | IDE 插件 | 实现位置 |
|---|---|---|---|---|
| 工具栏 `Ctrl+W` | 【新增】 | 关闭窗口/标签 | 被插件接管，**不会关闭面板**；内容不可关闭，被清空时自动重建 | `ZCodePanel` + `plugin.xml` + `ToolWindowFactory` |
| 面板懒启动 | 【新增】 | 应用启动即启动 server | 工具窗口打开时才启动 server；关光项目也常驻，重开秒连 | `ZCodeServerManager` |
| 索引期可用性 | 【新增】 | 不适用（Electron 不参与 IDE 索引） | 工具窗工厂声明 `DumbAware`，索引期间面板照常显示；未声明时平台会用 `DumbUnawareHider` 把整块内容换成 "not available until indexes are built" | `ZCodeToolWindowFactory` |
| server 进程模型 | 【相同】 | 单 server 多项目 | 单 server 多项目（全 IDE 一个进程） | `ZCodeServerManager` |
| server 端口 | 【修改】 | 由 Electron 主进程分配 | **全 IDE 固定一个端口**（`zcode.ide.server.port`），token 持久化；换端口等于换 origin，`localStorage` 全丢 | `ServerProcess.choosePort` |
| 项目路径来源 | 【修改】 | 应用内打开/切换工作区 | 由 webview URL 的 `ideWorkspace` 传入，server 不绑定项目 | `web-ide/src/main.tsx` |
| 数据目录 / 身份 | 【相同】 | `~/.zcode`，local 宿主 | 同一个 `~/.zcode`，同为 local 宿主；会话列表互通 | fork `entry-http.ts` |
| 与桌面客户端同时运行 | 【不支持】 | — | **不支持**：共享 SQLite，同时跑会锁冲突 | 运行时约束 |
| Node 运行时 | 【新增】 | Electron 内置 Node | 优先本机 Node 24，缺失时从镜像下载到插件目录（约 36MB，带校验） | `NodeRuntime` / `NodeProvisioner` |
| runtime 解析 | 【新增】 | asar 内置 | 4 级优先级：`-Dzcode.ide.runtime` → `ZCODE_IDE_RUNTIME` → `vendor/ZCode` → 插件 `runtime/` | `RuntimeLayout` |
| 多项目窗口 | 【修改】 | 单窗口内切换项目 | 每个项目一个 IDE 窗口/面板，各自锁定自己的项目，共用 server | `ZCodeIdeService` + URL `ideWorkspace` |

## 9. 网络与容器（明确不支持）

| 能力 | IDE 侧返回 | 表现 |
|---|---|---|
| 远程工作区 / remote attach | `remote_not_supported` | 相关入口不可用 |
| Web 远控 | 【支持】 | 侧栏手机按钮 → 官方弹窗生成 `zcode.z.ai/remote/v4` 二维码；手机浏览器登录同账号即可接管当前 IDE 项目 |
| Docker | `isDockerAvailable` 返回 `false` | 目标列表为空 |
| WSL / SSH | `listWSLDistros` / `listSSHConfigAliases` 返回空 | 目标列表为空 |
| Computer Use | 未实现 | 入口隐藏 |
| 内置浏览器 side pane | `clearEmbeddedBrowserData` 不支持 | 入口隐藏 |
| 终端 | 头部入口移除 | 无入口 |

## 10. 实现位置速查

| 区域 | 主文件 |
|---|---|
| 左侧栏数据结构与过滤 | `packages/ui/src/project-sidebar/index.tsx` |
| 左侧栏顶部导航 | `packages/ui/src/project-sidebar/ProjectSidebarNavigation.tsx`（上游原状）+ `packages/web-ide/src/styles.css`（入口隐藏） |
| 左侧栏列表头 | `packages/ui/src/project-sidebar/ProjectSidebarListHeader.tsx`（上游原状）+ `packages/web-ide/src/styles.css`（入口隐藏） |
| 左侧栏纯视觉隐藏 | `packages/web-ide/src/styles.css` |
| 侧栏折叠把手、草稿区、行号透传 | `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` |
| 头部按钮与 ➕ | `packages/ui/src/WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx` |
| 顶部浮层 | `packages/ui/src/DesktopTopOverlay.tsx`（上游原状）+ `packages/web-ide/src/styles.css`（整块隐藏） |
| 文件打开规则 | `packages/ui/src/lib/ideFileOpen.ts` + `hooks/useAppPanels.ts` |
| 宿主能力实现 | `packages/web-ide/src/idePlatform.ts` |
| IDE→Web 消息 | `packages/web-ide/src/ideContextPush.ts` |
| 归档/置顶代理、项目绑定 | `packages/web-ide/src/main.tsx` |
| 设置里的记忆入口 | `packages/ui/src/SettingsPage.tsx` |

## 11. 改这部分时必须守住

1. **桌面端与独立 Web 端零行为变化**：所有 UI 分叉必须 `isIdeHost()`；纯视觉隐藏优先 CSS。
2. **不伪装桌面**：`isDesktop` 保持 `false`，不要靠打开它来"借"桌面能力。
3. **不支持就显式不支持**：返回 `undefined` / `notSupported`，不要用假数据让界面看起来正常。
4. **新增能力先问能不能放插件侧**：优先插件实现（Kotlin + 桥 + platform），其次 web-ide CSS/platform，最后才改官方 UI。

## 12. 相关文档

- 适配原则与决策背景：[`IDE-HOST-ADAPTATION.md`](./IDE-HOST-ADAPTATION.md)
- 文件级适配点与桥契约：[`PROJECT-MAP.md`](./PROJECT-MAP.md)
- 硬约束（第 4、13 条）：[`INVARIANTS.md`](../development/INVARIANTS.md)
- 完成度与已知缺口：[`STATUS.md`](../development/STATUS.md)
