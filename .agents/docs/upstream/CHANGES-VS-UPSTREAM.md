# 相对上游的官方源码改动清单

> **基线**：`upstream/main` = `3c5b2276`（2026-10-20，源码版本 3.16.2）
> **当前 fork HEAD**：`b177da31`（`ide-integration`）
> **统计时间**：2026-10-28
> **权威数据**：`node scripts/patch-budget.mjs --json`（不要以本文档的表格为最终口径，脚本才是）
> **维护规则**：每次同步上游、每次新增/删除官方源码补丁，都必须更新本文件（见 §7）。

## 0. 总览

| 指标 | 数值 | 说明 |
|---|---|---|
| 官方源码**修改**文件 | **19** | 计入补丁预算 |
| 官方源码**新增**文件 | **17** | 不计入预算（零冲突）；含 `packages/ide-remote-bridge/` 12 个、`ideHost.ts`/`ideFileOpen.ts`/`legacy-remote-tasks.ts` 与 2 个迁移的 `*.ide.test.ts` |
| **排除**文件 | **10** | `packages/web-ide` 9 个 + `pnpm-lock.yaml` |
| 触碰文件合计 | **46** | 19 + 17 + 10 |
| 补丁预算 | **19 / 23** | `vendor/zcode.lock` 的 `patchBudget.maxModified`，余 4 |
| 相对上游的提交 | **9 个** | 全部线性位于 `upstream/main` 之上 |
| 代码量 | 约 +1500 / −75（官方部分，含未提交） | `git diff --stat 3c5b2276`（官方文件） |

> 2026-10-25 预算 18 → 23（工作区改动）；2026-10-28/29 两次把 IDE 推送（文件、选区）改走官方
> 既有事件链路，`SessionPane.tsx` 补丁还原；2026-10-29 收敛分析再还原 `App.tsx`（零行为差异）并把
> 2 个测试用例迁到新增 `*.ide.test.ts`（官方测试文件还原），修改数 23 → 19（见 changes/ 对应记录）。
> 剩余 19 个均为「官方调用链内部的行为修复/数据管道」，暂无插件侧替代手段；
> `remote-workspace-identity` 的盘符形态是通用缺陷，值得反馈上游，修复后自动再减 1。

## 1. 判定口径

- **官方源码**：`vendor/ZCode` 中上游已存在的文件。
- **计入预算**：官方源码的 `M`（修改）。测试文件同样计入。
- **不计入预算**：`A`（新增，例如 `ideHost.ts`、`ideFileOpen.ts`、`legacy-remote-tasks.ts`）。
- **排除**：`packages/web-ide/`（我们新增的 IDE Web 入口）与 `pnpm-lock.yaml`。
- 统计命令：

```bash
node scripts/patch-budget.mjs             # CI 口径（fork HEAD 对比锁里的 upstreamBase）
node scripts/patch-budget.mjs --worktree  # 含未提交改动
node scripts/patch-budget.mjs --json      # 机器可读，本文档的数据来源
```

## 2. 按提交的改动（9 个）

| 提交 | 主题 | 解决的问题 | 官方文件 |
|---|---|---|---|
| `60ffe5db` | 旧任务行 identity 补全 + Windows 盘符自愈 | 历史会话点开无反应；项目路径出现 `E:\E:\` | 6（1 新增） |
| `7aae0cc7` | composer scope 与最近模型播种 | 新建对话总是回落到默认模型 | 2 |
| `5f6d3803` | `ideHost=1` 门控的 IDE 形态精简 | 工具窗口里堆满桌面端入口；新建任务无反应 | 12 → 最终 9 |
| `f07cd1cf` | 自建 IDE 版 Web 入口 | 官方 Web 端没有 IDE 宿主所需的平台实现 | 9（8 新增 + lock） |
| `261fa358` | 独立 server 改 local 宿主形态 | IDE 与桌面客户端的会话列表互不可见 | 1 |
| `eded5be9` | 会话内点文件统一进 IDE 编辑器 | 点文件进内置查看器 / 打不开；行号丢失 | 10 |
| `f2f72b14` | 侧栏隐藏改 CSS 承接 + sessions 事件驱动自愈 | 官方 UI 补丁面过大；running 图标不转圈 | 5 |
| `cf345dcb` | 顶部浮层隐藏改由 web-ide CSS 承接 | `DesktopTopOverlay.tsx` 补丁整个还原为上游原状，压缩补丁面 | 2（其中 1 个还原归零） |
| `b177da31` | Web 远控 device 桥 + workspaceKey 去重 + 复审加固 | 手机 `/remote/v4` 需要 IDE 宿主桥；同一项目两套 agent；桥进程健壮性与类型门槛 | 15（1 修改 + 12 新增；idePlatform/pnpm-lock 排除） |

> `5f6d3803` 中的 `ProjectSidebarListHeader.tsx`、`ProjectSidebarNavigation.tsx` 已被 `f2f72b14` 还原为上游原状（改动改由 web-ide CSS 承接），`DesktopTopOverlay.tsx` 也已被 `cf345dcb` 还原（整个顶部浮层由 web-ide CSS 隐藏），三者都不再计入当前 diff。

## 3. 逐文件记录

列含义：

- **改动**：具体改了哪些代码。
- **为什么改**：触发这次补丁的需求或缺陷根因。
- **修改后**：实现的功能或修复后的用户可见行为。
- **约束与风险**：为什么必须留在官方源码，以及 rebase 时的冲突风险。

### 3.1 packages/server（1 修改 + 1 新增）

| 文件 | 改动 | 为什么改 | 修改后 | 约束与风险 |
|---|---|---|---|---|
| `src/entry-http.ts`（M） | 入口从 `createServerHostServices`（身份 `remote:server:<id>`）改为 `createLocalServices`（`ownerHostId="local"`）；去掉 `workspaceIdentityMapper` 与 `virtualProjects`；启动时调用 `normalizeLegacyRemoteTasks` | 独立 server 原先给项目/会话打 remote 身份，和桌面客户端（local 宿主）的数据完全隔离；插件只是桌面客户端的另一种外壳，应当共享同一套 `~/.zcode` 数据 | IDE 与桌面客户端同身份，会话列表互通；早期 remote 任务行被自动修正 | **必须**：server 启动装配只能在进程内完成。**风险：高**，入口重构时必冲突 |
| `src/legacy-remote-tasks.ts`（A） | 新增 `normalizeLegacyRemoteTasks`：把 `workspace_identity` 为空的旧 `remote:server:<id>` 任务行补成当前 local 身份，幂等 | 早期插件写入的任务行缺 identity；新版 UI 按 identity 解析 scope，点开时匹配不到同一个 key，界面既不加载也不报错（"点历史会话卡住"） | 历史任务行自愈，旧会话可正常点开；重复执行无副作用 | **必须**：要直接写 SQLite，且必须在 server 启动早期。**风险：低**（独立新文件） |

### 3.2 packages/shared（2 修改 + 1 新增）

| 文件 | 改动 | 为什么改 | 修改后 | 约束与风险 |
|---|---|---|---|---|
| `src/platform.ts`（M） | `openExternalFile(path, location?)` 增加可选行/列；新增可选能力 `selectInProjectView(path)` | IDE 打开文件需要定位到具体行；目录链接需要定位到 IDE 项目树，而不是再开一层内置文件树 | 点消息里的 `文件:12` 直接跳到第 12 行；点目录定位到项目树 | **必须**：`IPlatformService` 是官方共用契约，不改类型插件侧无法实现。**风险：低**（纯可选能力位，桌面/Web 端不实现即 undefined） |
| `src/remote-workspace-identity.ts`（M） | 解析时把 identity 里的 `/E:/x` 还原为 `E:/x`；`remoteHostIdFromWorkspaceIdentity` 按还原后的尾段长度裁剪 | Windows 路径在 identity 中以 `/E:/x` 形态存储，解析后仍带前导斜杠，被当作"有根无盘符"路径拼到当前盘符下，产生 `E:\E:\x`；hostId 裁剪会因少一个字符而错位 | Windows 项目路径不再翻倍；任务与工作区的归属 identity 正确 | **必须**：身份构造/解析在 shared，server 与 CLI 共用，插件侧拿不到调用点。**风险：中**，上游改动该文件时需逐行核对。**这是通用缺陷，建议反馈上游，修复后本补丁自动收敛**（配套用例已迁至 `test/remoteWorkspaceIdentity.ide.test.ts`，官方测试文件保持上游原状） |
| `test/remoteWorkspaceIdentity.ide.test.ts`（A） | 新增（不计预算）：Windows 盘符还原、`build(parse(identity))` 恒等、hostId 裁剪 2 个用例（自官方测试文件迁出） | 锁住盘符形态的解析行为，防止上游重构身份格式时静默回归 | 用例随 IDE 补丁独立维护，官方测试文件保持上游原状 | 新增文件；vitest include 天然覆盖。**风险：低** |

### 3.3 apps/zcode-cli（1 修改 + 1 新增）

| 文件 | 改动 | 为什么改 | 修改后 | 约束与风险 |
|---|---|---|---|---|
| `packages/core/src/runtime/helpers/persisted-remote-session-path-repair.ts`（M） | 识别旧版本落库的前导斜杠形态（`/E:/x`）并修复 | 旧版本把 identity 归一形态直接写进会话数据，读出来后与真实路径不相等，会话目录指向错误位置 | 存量会话路径自动修复，无需手工改库 | **必须**：会话数据在 agent 侧读写，插件侧无法介入。**风险：低**（单个分支判断；配套用例已迁至 `tests/persisted-remote-session-path-repair.ide.test.ts`，官方测试文件保持上游原状） |
| `packages/core/tests/persisted-remote-session-path-repair.ide.test.ts`（A） | 新增（不计预算）：前导斜杠形态修复用例 + 自包含 helper（自官方测试文件迁出） | 锁住修复条件，避免上游调整修复器时丢失该分支 | 官方测试文件保持上游原状；helper 为副本，官方改 helper 时需人工同步 | 新增文件；`vitest tests` 天然覆盖。**风险：低**（helper 漂移） |

### 3.4 packages/ui（15 修改 + 2 新增）

| 文件 | 改动 | 为什么改 | 修改后 | 约束与风险 |
|---|---|---|---|---|
| `src/lib/ideHost.ts`（A） | 新增 `isIdeHost()`：读 URL 的 `ideHost=1` | 需要一个统一开关区分"IDE 内嵌形态"与桌面端/独立 Web，否则每处改动都要自己判断来源 | 所有 IDE 专属分支只影响插件内嵌页，桌面端与 Web 端零变化 | 新文件，无冲突。**风险：低** |
| `src/lib/ideFileOpen.ts`（A） | 新增 `openFileSourceInIdeEditor`：类型准入（`file`/`patch`/`multi-file-diff`/`text`）→ 路径解码、相对转绝对、段归一化 → 调 `platform.openExternalFile`，`file` 源透传行号列号 | 同一套"点文件怎么打开"的规则曾在 5 个组件里各写一份，后续入口新增就要再找一遍；需要收敛成一个判定点 | 对话链接、预览卡片、变更文件行、工具调用行、面板文件树行为一致；媒体/PDF/PPT/图片仍走内置预览 | 依赖上游 `CodeViewerSource` 结构。**风险：低**（新文件，但类型变化会直接影响） |
| `src/hooks/useAppPanels.ts`（M） | 三个汇合点：`handleOpenCodeViewer`、`handleNavigateFileManager` 改投 IDE 编辑器；`handleOpenFileManager` 改用 `selectInProjectView`（工作区外临时目录保留内置文件树） | 这两个函数是全站唯一的内置查看器/文件树入口；只改调用点会漏掉对话链接、工具调用行等来源。另外从对话被带进内置文件树后，再点文件会一直困在面板里 | 所有入口点文件都开在 IDE 编辑器并带行号；目录定位到 IDE 项目树；工作区外目录仍有兜底 | **必须**：不改这里就无法一次覆盖全部调用点。**风险：高**（核心入口，上游改动频繁） |
| `src/app-shell/WorkspaceShellLayout.tsx`（M） | IDE 下不渲染草稿输入框上方的项目/分支切换；新增侧栏右缘折叠把手；消息链接的行号列号透传到打开请求 | IDE 里项目和分支由 IDE 自己管理，重复入口占高度；侧栏收起后没有可见的展开入口；上游解析出了行号但打开时丢失 | 草稿区更简洁；侧栏可折叠并在左边缘保留展开按钮；点链接定位到行 | **必须**：布局与渲染逻辑在官方组件内，`executeJavaScript` 改不了。**风险：高**（大文件 + 结构改动） |
| `src/WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx`（M） | IDE 下隐藏帮助/终端/右侧面板，右上角只留「新建对话 ➕」；侧栏收起时先展开再新建 | 这些是桌面产品入口，在工具窗口里用不上且挤占标题区；无活动任务时上游不渲染 header，导致欢迎页没有新建入口 | 标题区只剩一个清晰的 ➕；点击一定能在侧栏看到新建的会话 | **必须**：渲染分支在官方组件里。**风险：高**（该区域上游重构过） |
| `src/WorkspaceHeaderSections/shared.ts`（M） | 增加 `isSidebarVisible` / `onToggleSidebar` / `onCreateTask` 类型 | 支撑上面的头部行为 | 类型透传 | **风险：低** |
| `src/WorkspaceHeader.tsx`（M） | 把 `onToggleSidebar` / `onCreateTask` 透传给 ActionSection | 同上，组件层级需要把回调传到实际渲染点 | 回调可用 | **风险：低** |
| `src/project-sidebar/index.tsx`（M） | IDE 下只显示当前工作区所属项目的未归档任务；项目列表未到达时保持空列表；新建任务不再传 `projectId: null`；顶部拖拽条缩为 `h-2` | 桌面侧栏显示所有项目，而插件每个窗口应锁定当前项目；项目列表加载瞬间会闪出其它项目的任务；`projectId: null` 会被当成显式目标，跳过从活动工作区继承身份，导致模型偏好读错桶；IDE 没有顶部浮层却留了 48px 拖拽条 | 侧栏只显示本项目的最近对话；无加载闪烁；新建对话沿用当前工作区身份；顶部空间归还给内容 | **必须**：项目/任务过滤在官方侧栏组件内。**风险：高**（主文件，上游改动频繁） |
| `src/v4/useWorkspaceSessionsIndexItems.ts`（M） | 订阅 `workspace_task_list_changed`，按事件所属 scope 调 `resyncNow()` 重订 sessions-index | IDE 没有 window-controller 通道，侧栏状态完全依赖这条 lane；宿主侧 runtime 被外部回收/替换时订阅会静默失效，之后新会话的 running 状态永远到不了列表 | 运行中任务重新转圈；按事件所属 workspace 重订，避免只修当前窗口 | **必须**：订阅与投影逻辑在官方 hook 内。**风险：中** |
| `src/v4/sessionsIndexStore.ts`（M） | 新增 `resyncNow()`：携当前 transport 全量重订，3 秒限流；不能用 `awaitingInitial` 当锁 | store 停在旧快照时需要一个外部强制刷新入口；轮询会造成订阅风暴，必须事件驱动 | 提供安全的重订能力，多消费者同时触发也不会重复订阅 | **必须**：store 是官方状态容器。**风险：中** |
| `src/root/useRootWorkspaceActions.ts`（M） | 同一工作区路径沿用已有远端 identity；已挂同一附件时跳过远程导航 | `prepareSession` 只回路径会让新草稿降级为 path-only，最近模型/草稿读不到；插件没有 `openRemoteProjectWorkspace`，漏判会抛 `project.remote-navigation-unavailable`，表现为"点新建毫无反应" | 新建对话保留身份与最近模型，不再无响应 | **风险：中**（通用修复，rebase 重点核对） |
| `src/lib/composerRecent.ts`（M） | 写入时额外落一份 workspace 级副本；读取时精确 key 缺失回退到该副本 | 任务列表的「新建任务」入口不携带 `projectId`，只写项目作用域会让用户刚选的模型在新建对话时回落到默认值 | 新建对话沿用上一次选择的模型 | **风险：中**（通用修复） |
| `src/v4/composer/useDraftConfigControl.ts`（M） | 空正文「新建任务」每次进入按 Recent 重新播种一次模型，用 `scopeKey` 闸门避免覆盖用户改选 | 草稿里残留的 `modelSelection` 会一直压住用户在别的会话刚切过的模型，表现为"点新增对话还是默认模型" | 新建对话使用最近使用模型，同一次编辑中的手动改选不被覆盖 | **风险：中**（通用修复） |
| `src/SettingsPage.tsx`（M） | 记忆详情入口改为 `isDesktop \|\| isIdeHost()` | 记忆详情读的就是本机目录，IDE 宿主同样可读；上游把"能不能读"写死成 `isDesktop`，没有能力位可拦截 | IDE 设置里能看到记忆列表与详情 | **必须**：唯一没有能力位的上游判断。**风险：低**（1 行 + import + 注释） |
| `src/lib/codeViewer.ts`（M） | `FileCodeViewerSource` 增加可选 `lineNumber` / `columnNumber` | 上游已从链接里解析出行号，但 source 结构没有字段承载，打开时丢失 | 文件源可以携带行号列号 | **风险：低**（纯可选字段） |
| `src/components/ai-elements/message.tsx`（M） | `MessageFileLinkTarget` 增加行号列号，并把 markdown 链接解析结果一路透传 | 同上，消息渲染层是行号的来源 | 消息里的 `文件:12:3` 能带到打开请求 | **风险：低** |
| `src/WorkspaceSidebarFooter.tsx`（M） | 远控触发按钮条件从 `isDesktop` 改为 `isDesktop \|\| isIdeHost()`；新增 `isIdeHost` import | IDE 宿主已提供远控 device 桥，但上游把入口写死成 `isDesktop`，插件内看不到按钮 | IDE 侧栏底部出现手机远控按钮；桌面端与独立 Web 端行为不变 | **必须**：入口渲染在官方 footer 组件内。**风险：低**（1 行条件 + import） |

### 3.5 排除项（10 个，不计预算）

| 文件 | 作用 | 为什么需要 | 修改后 |
|---|---|---|---|
| `packages/web-ide/index.html` | IDE Web 入口 HTML | 官方没有面向 JCEF 的入口页面 | 可直接加载官方 Root |
| `packages/web-ide/package.json` | 新包定义 | 需要一个独立可构建的 IDE Web 包 | `pnpm --filter @zcode/web-ide build` 可用 |
| `packages/web-ide/vite.config.ts` | 构建配置 | 产物需被 `build-runtime.mjs` 直接消费 | 生成 `dist/` |
| `packages/web-ide/src/main.tsx` | URL 解析（`ideWorkspace` 优先）、`createIdePlatform`、`forIdeHost` 代理屏蔽 `windowControllerService` | IDE 没有 Electron 的 window-controller 通道，保留会让归档/置顶报 `Unknown channel`；server 共享后 server-info 的工作区只是默认值 | 每个窗口锁定自己的项目；归档/置顶正常 |
| `packages/web-ide/src/idePlatform.ts` | 官方 `IPlatformService` 的 IDE 实现：文件对话框、打开文件、另存为、MCP 用户目录、base64 过桥 | 桥只能传 JSON，`ArrayBuffer` 过 JSON 会变成 `{}`；MCP 本地 workspace 固定走 platform 分支，stub 会让"已安装"恒为 0 | 本机文件能力可用；MCP 列表正确；另存为真正落盘 |
| `packages/web-ide/src/ideBridge.ts` | `invoke()` 封装与 `__zcodeIdeResolve` 回填 | 把 JCEF 桥包装成 Promise | 前端可 `await` 桥调用 |
| `packages/web-ide/src/ideContextPush.ts` | `__zcodeIdeMessage` 的 op 分发（`filesToInput`、`selectionToInput` 等） | IDE → Web 需要一条消息通道；选区只应发路径与行锚点，不应把整段代码塞进 prompt | 右键发送引用、选区插入可用 |
| `packages/web-ide/src/styles.css` | IDE 形态纯视觉隐藏：侧栏入口（`data-testid`）、顶部浮层根节点（`topoverlayer` 容器名）、`pl-38`/`pl-44` 左侧留白 | 纯视觉隐藏放在 CSS 可以不给官方 UI 增加补丁面，且桌面端不加载这份 CSS；`DesktopTopOverlay.tsx` 因此已还原为上游 | 侧栏收起后左上角无图标、顶部无空白占位、会话标题左侧无留白；官方源码零改动 |
| `packages/web-ide/tsconfig.json` | 编辑器类型检查配置（2026-10-26 随 web-ide 类型声明补全新增） | web-ide 需要 standalone 的 tsconfig 供 IDE 检查 | `tsc` 可独立检查 web-ide |
| `pnpm-lock.yaml` | web-ide 依赖 | 新包需要锁文件条目 | 可复现安装 |

上游没有 `packages/web-ide` 这个包，整包新增不会与上游冲突；rebase 时只需确认它依赖的官方导出仍存在。

### 3.6 packages/ide-remote-bridge（12 新增，不计预算）

| 文件 | 作用 | 为什么放在 fork 侧 |
|---|---|---|
| `package.json` / `scripts/build.mjs` | 独立构建单文件 ESM（esbuild，复用仓库根依赖）；`test` 脚本跑 workspace-keys 回归测试；`typecheck` 用根 typescript 检查整包；声明 `@zcode/rpc` workspace 依赖（tsc 走其 dist 声明，esbuild 仍走 src，产物不变） | 需要直接 import `packages/desktop` 的 relay transport 与 `packages/client` 的分片适配 |
| `tsconfig.json` | 类型检查配置：extends base + noEmit；rpc 走包名声明消费，desktop/shared/client 源码按 base 口径连带检查。不进根 typecheck 的 tsc -b 清单（非 composite，且根脚本属官方文件、预算已满） | 桥此前只有 esbuild 转译、零类型门槛；契约漂移要靠运行时才暴露 |
| `src/shims.d.ts` | `declare module "node-forge"`——上游 services 对 node-forge 本就是隐式 any，连带检查时显式补齐同一语义 | 不加会连带上游源码的误报 |
| `src/device.ts` | 复用 `WebRemoteControlDeviceTransport`；补 bootstrap/workspace-list/bridge-open，把 `rpc-frame` 转到本地 `/ws`。**workspaceKey 一律用 server 原始 `rootPath`**（server 按字面字符串派生 agent，换写法会重复拉 agent）；local 目标不下发 `workspaceIdentity` | 官方 manager 与 Electron Window Host 强绑定，不能整包复用；只重写业务消息层 |
| `src/workspace-keys.ts` | 工作区 key 的统一判定点：归一化只用于比较，下发/回写用 server 原始写法；含 `resolveWorkspaceTarget`/`dedupeWorkspacePaths` | 与上面的 key 规则同源，避免 device.ts 里再长出第二份比较逻辑 |
| `test/workspace-keys.test.ts` | 5 个回归测试（正反斜杠匹配、identity 匹配、返回原始写法、去重、归一化不改变下发值） | `node --experimental-strip-types --test` 直接跑 TS，不需要测试框架 |
| `src/server-link.ts` | `ws` + `SocketProtocol` 连本地 server `/ws` | 插件宿主没有 Electron MessagePort，对应物是 server 的 WS Channel |
| `src/credentials.ts` | 读 `~/.zcode/v2/credentials.json` 的 `zcodejwttoken` | desktop 用 Electron 凭据服务；插件侧用同一份文件即可，不新增账号体系 |
| `src/telemetry-shim.ts` | 替换 transport 的 desktop 遥测 import | 让官方 transport 保持零改动（构建期 alias） |
| `src/terminal-probe.ts` | 模拟手机 terminal 的端到端自检（默认 key 用 `workspacePath`） | 不依赖真机即可验证配对、bootstrap、bridge、RPC 转发 |
| `src/index.ts` | CLI 入口；stdout 只输出 ready JSON；支持 `--state-file` 临时设备（验证用） | IDE 侧需要机器可读的 `deviceSid`/`qrUrl` |

整包新增，不与上游路径冲突；rebase 时确认 `webRemoteControlTransport.ts`、`webRemoteControlV2Http.ts` 的
导出与构造参数未变（这两个文件若被上游重命名，桥需要同步改 import 路径）。

## 4. 冲突风险分级

| 级别 | 文件 | 同步时的处理 |
|---|---|---|
| **高** | `ui/app-shell/WorkspaceShellLayout.tsx`、`ui/WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx`、`ui/project-sidebar/index.tsx`、`ui/hooks/useAppPanels.ts`、`server/entry-http.ts` | 逐个 hunk 手工合并；优先保留我们的 IDE 分支与 local 装配 |
| **中** | `ui/root/useRootWorkspaceActions.ts`、`ui/v4/composer/useDraftConfigControl.ts`、`ui/lib/composerRecent.ts`、`ui/v4/sessionsIndexStore.ts`、`ui/v4/useWorkspaceSessionsIndexItems.ts`、`shared/remote-workspace-identity.ts`、`shared/platform.ts` | 先看上游是否重构了同名函数/类型；行为修复优先保留 |
| **低** | `ui/SettingsPage.tsx`、`ui/WorkspaceHeader.tsx`、`ui/WorkspaceHeaderSections/shared.ts`、`ui/lib/codeViewer.ts`、`ui/components/ai-elements/message.tsx`、`ui/WorkspaceSidebarFooter.tsx`、`cli/persisted-remote-session-path-repair.ts` | 通常直接取上游 + 重新加 1–N 行 |
| **无** | 5 个新增官方文件（`legacy-remote-tasks.ts`、`ideHost.ts`、`ideFileOpen.ts`、2 个 `*.ide.test.ts`）、`packages/web-ide` 整包、`packages/ide-remote-bridge` 整包 | 仅确认依赖的导出未变 |

## 5. 同步上游时的检查清单

1. `node scripts/patch-budget.mjs --json` 记录同步前的数字与文件清单。
2. `git fetch upstream --tags` 后，先看 `upstream/main` 是否新增提交；没有就只更新 §0 的统计时间与 §8 记录。
3. rebase 后用脚本对比文件清单，逐项确认：上游删除/重命名的文件我们是否仍需要补丁；上游是否已原生实现（那就删掉我们的补丁，收回预算）。
4. 重点核对：
   - `IPlatformService` 是否新增**必填**方法（`packages/web-ide/src/idePlatform.ts` 必须补齐）；
   - `CodeViewerSource` 的 source 类型是否变化（`ideFileOpen.ts` 的准入集合要跟着改）；
   - `useAppPanels` 的三个汇合点函数名/签名是否变化；
   - `entry-http.ts` 的入口装配是否被上游重写；
   - `SessionsIndexStore` 的订阅接口是否变化（`resyncNow` 依赖 `connect(transport, {forceSnapshot})`）。
5. 同步后重新验证，并更新 `vendor/zcode.lock`（`node scripts/bootstrap.mjs --update`）。

## 6. 验证清单（同步后至少跑一遍）

- [ ] `node scripts/patch-budget.mjs` 未超预算
- [ ] `pnpm --filter @zcode/server build`、`pnpm --filter @zcode/ui build`、`pnpm --filter @zcode/web-ide build` 通过
- [ ] `node scripts/build-runtime.mjs` 后 `dist/BUILD-INFO.json` 的 commit 与新锁一致
- [ ] IDE 内：项目/会话列表正常、历史会话可点开、发消息与流式回复正常
- [ ] 点文件进 IDE 编辑器（对话链接、预览卡片、变更文件行、面板文件树）
- [ ] 目录链接定位到 IDE 项目树
- [ ] 编辑器选区发送到输入框（code-comment 附件挂输入框上方，不覆盖草稿）
- [ ] 迁移的 `*.ide.test.ts` 被 runner 发现且全绿（`packages/shared/test/remoteWorkspaceIdentity.ide.test.ts`、`apps/zcode-cli/packages/core/tests/persisted-remote-session-path-repair.ide.test.ts`）
- [ ] 项目树右键「添加到 ZCode 对话」：引用追加到输入框末尾（官方「加入对话」事件链路）
- [ ] 新建对话沿用最近使用的模型
- [ ] 侧栏 running 图标能正常出现
- [ ] 归档/置顶不报错
- [ ] 桌面端与独立 web 端无行为变化（`isIdeHost()` 均未命中）

## 7. 更新规则（每次都必须做）

**触发条件**：任何一次 `git fetch upstream` 后（无论有没有新提交）、任何新增/删除/还原官方源码补丁之后。

必须完成：

1. 跑 `node scripts/patch-budget.mjs --json`，核对 §0 的修改数、新增数、排除数、总文件数。
2. 若补丁文件有增删，更新 §3 的逐文件表（删掉已还原的文件，补上新增的补丁）。
3. 若 rebase 后冲突处理改变了实现，更新对应行的**改动 / 为什么改 / 修改后 / 风险**四项。
4. 更新 §0 的基线 commit、fork HEAD、统计时间。
5. 在 §8 追加一行同步记录。
6. 在 [`../changes/`](../changes/) 新增一条同步记录（全项目的时间线；本文档只维护官方补丁的累积快照）。
7. 同步完成时更新 `vendor/zcode.lock`：`node scripts/bootstrap.mjs --update`。
8. 如果因此**新增**了官方源码修改，必须先说明为什么插件侧做不到；预算不足时先显式上调 `patchBudget.maxModified` 并在记录中写明原因。

## 8. 同步记录

| 日期 | 上游基线（旧 → 新） | 处理 | 冲突文件 | 结果 | 锁 commit |
|---|---|---|---|---|---|
| 2026-10-25 | `3c5b2276` → `3c5b2276` | 新增 Web 远控 device 桥：`packages/ide-remote-bridge` 整包 + `ui/WorkspaceSidebarFooter.tsx` 放开入口 | 无（新增文件） | 23 修改 / 11 新增 / 23 预算（用满）；relay 协议与客户端适配全部复用官方实现 | `b177da31` |
| 2026-10-25 | `3c5b2276` → `3c5b2276` | 修复同一项目重复 agent：`ide-remote-bridge` 新增 `src/workspace-keys.ts` + `test/`，device 列表/bridge-open 改用 server 原始 `rootPath` | 无（新增文件） | 23 修改 / 13 新增 / 23 预算（用满）；3 窗口实测 1 server + 3 agent 无重复 | `b177da31` |
| 2026-10-25 | `3c5b2276` → `3c5b2276` | 只 fetch，无新提交 | 无 | 无需 rebase；23 修改 / 3 新增 / 23 预算 | `f2f72b14` |
| 2026-10-28 | `3c5b2276` → `3c5b2276` | 无上游同步；曾有 insert-at-cursor 官方补丁（3 文件，+3 预算），按「尽量不改官方源码」底线原则**全部还原**；IDE 推送改走官方 `WORKSPACE_FILE_ADD_TO_CHAT_EVENT` 事件（插件侧 `ideContextPush.ts`，排除项） | 无（还原归零） | 23 修改 / 15 新增 / 23 预算（余 0，与 10-25 持平）；引用追加到输入框末尾，与官方桌面端一致 | `b177da31` |
| 2026-10-29 | `3c5b2276` → `3c5b2276` | 无上游同步；选区推送改走官方 `CODE_COMMENT_ADD_TO_CHAT_EVENT` 事件（插件侧）；实测确认 `SessionPane.focused` 为分屏 pane 语义（单面板恒 true），官方事件恒被消费，**`SessionPane.tsx` 补丁还原为上游原状** | 无（还原归零） | **22 修改** / 15 新增 / 23 预算（**余 1**）；选区引用以 code-comment 附件挂输入框上方，零覆盖 | `b177da31` |
| 2026-10-29 | `3c5b2276` → `3c5b2276` | 无上游同步；收敛分析后**再还原 3 个文件**：`ui/App.tsx`（纯类型收紧，对上游 0 diff）、`shared/test/remoteWorkspaceIdentity.test.ts` 与 `cli/core/tests/persisted-remote-session-path-repair.test.ts`（用例迁至新增 `*.ide.test.ts`） | 无（还原归零） | **19 修改** / 17 新增 / 23 预算（**余 4**）；新旧测试全绿；评估后未做 WorkspaceHeader 束与 entry-http 收敛（需牺牲 ➕ 入口或复刻装配脚本） | `b177da31` |

## 9. 相关文档

- 上游同步流程与分支模型：[`ZCODE-UPSTREAM-SYNC.md`](./ZCODE-UPSTREAM-SYNC.md)
- 宿主适配原则：[`../architecture/IDE-HOST-ADAPTATION.md`](../architecture/IDE-HOST-ADAPTATION.md)
- 文件级地图与桥契约：[`../architecture/PROJECT-MAP.md`](../architecture/PROJECT-MAP.md)
- 部署与验证：[`../skills/deploy-zcode-plugin/SKILL.md`](../../skills/deploy-zcode-plugin/SKILL.md)
