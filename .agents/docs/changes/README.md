# 变更记录（change log）

> 本项目由 AI 开发与维护，**代码之外必须有可追溯的文字记录**：改了什么、为什么改、影响什么、验证到哪一步。
> **没有记录 = 改动未完成。** 这条规则写在 [`../../../AGENTS.md`](../../../AGENTS.md) 的红线与完成标准里。

## 1. 什么时候必须写

任何一次对**源码或构建输入**的修改，提交前都必须在这里新增一篇：

- `src/`（Kotlin、`plugin.xml`、资源）
- `scripts/`（构建、迁移、校验脚本）
- `vendor/ZCode/` 中我们修改或新增的文件（fork 侧，含 `packages/web-ide`）
- `build.gradle.kts`、`settings.gradle.kts`、`gradle.properties`、`vendor/zcode.lock`
- `.agents/skills/`（部署与验证脚本）

纯文档修改不强制单独成篇；但**结构性调整**（移动目录、重写入口、改变维护规则）建议记一条，方便后来者理解为什么变成现在这样。

本地 IDE 配置（`.idea/`，不入库）如有重要变更，也在记录里注明。

## 2. 位置与命名

```
.agents/docs/changes/YYYY-MM-DD-<slug>.md
```

同一天多个主题加序号：`YYYY-MM-DD-2-<slug>.md`。文件名用小写英文与连字符，例如 `2026-10-25-docs-overhaul.md`。

## 3. 模板

复制下面的结构，按需增删，但**六个核心项不能省**：范围、为什么、改了什么、行为变化、验证、风险。

```markdown
# YYYY-MM-DD · 一句话标题

- **范围**：插件 Kotlin / web-ide / ui / server / scripts / 文档 / 本地配置
- **触发**：用户需求 / bug / 上游同步 / 重构
- **提交**：`<sha>`（未提交时写 working tree）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `path/to/file` | 新增 / 修改 / 删除 | 具体改了什么 |

## 为什么改

根因、需求背景、被否决的方案（如果有）。

## 行为变化

用户可见的效果，或"无行为变化，仅内部重构"。

## 验证

跑了什么命令、看了哪条日志、CDP 验证了什么；没验证就写"未验证"及原因。

## 风险 / 后续

遗留问题、需要复测的点、依赖的上游变化。

## 相关

相关文档、上游提交、issue。
```

## 4. 与官方补丁清单的分工

| 文档 | 记什么 | 更新时机 |
|---|---|---|
| `changes/*.md` | **每次改动的时间线**：谁在什么时候改了什么、为什么 | 每次改源码 |
| [`upstream/CHANGES-VS-UPSTREAM.md`](../upstream/CHANGES-VS-UPSTREAM.md) | **当前官方补丁的快照**：文件清单、预算、冲突风险、同步记录 | 每次同步上游或增删官方补丁 |

改了官方源码时，两份都要写：`changes/` 记这次做了什么，`CHANGES-VS-UPSTREAM.md` 更新累积快照与预算。

## 5. 提交前自检

```bash
node scripts/check-change-log.mjs          # 检查暂存区（无暂存则看最近一次提交）
node scripts/check-change-log.mjs --base=HEAD~3
```

规则：改动里出现源码/构建文件，但 `changes/` 下没有新增或修改的记录 → 脚本失败。
`vendor/ZCode` 是独立仓库，插件仓库的 diff 看不到它的改动；在 fork 里提交后要手动在记录里列出。

## 6. 索引（最新在上）

| 日期 | 记录 | 摘要 |
|---|---|---|
| 2026-10-29 | [公开仓库门面：截图、徽章、英文 README、Issue 模板](./2026-10-29-28-public-readme-facade.md) | README 首屏改为徽章→截图→一句话定位→一行安装→为什么→功能→不支持→构建；新增 `README.en.md`、`docs/images/panel.png`（真实窗口裁剪，避开个人路径与账号区）、3 个 Issue 模板；发布快照 `2be4a4c`（首次推送漏了未提交文件，已重发） |
| 2026-10-29 | [ZCode fork 公开到 GitHub（含本机标识清理）](./2026-10-29-27-github-fork-public.md) | fork `doyzhengdev/ZCode` 已公开并设置 description/topics；清理补丁树里 4 个测试/注释文件的本机标识（`<host>`、`E:/work/*`、`<your-bucket>`，含大小写变体），三个相关测试全绿；`github` 与 `fork` 两个 remote 推到 `f17677b6`，`vendor/zcode.lock` 同步；补丁面仍 19/23 |
| 2026-10-29 | [在官方仓库的 fork 网络里出现](./2026-10-29-26-github-fork-network.md) | GitHub fork 网络只认 GitHub 上的 fork：新建 `doyzhengdev/ZCode`（parent=zai-org/ZCode），`main` 与 upstreamBase 一致，推上 `ide-integration`（5aa74794）；fork 的 husky `pre-push` 依赖 `origin/staging`，推送需 `--no-verify`；同步文档改为实际的 `fork`/`github` remote |
| 2026-10-29 | [修复安装器在中文 Windows 上的乱码输出](./2026-10-29-25-npm-installer-output-garbled.md) | 根因：Windows 系统命令（taskkill/tasklist/powershell）重定向输出按控制台代码页（中文为 GBK/CP936）写字节，安装器却按 UTF-8 解码；新增 `decodeSystemOutput`（严格 UTF-8 → gb18030 → 宽松）+ `runWindowsTool` 统一解码，多行报错压成一行防刷屏；顺带修好中文系统上永远匹配不到「拒绝访问」导致 UAC 提权失效的问题；11 + 100 用例全绿，真实 taskkill 输出对比验证；需发 0.0.9 才对 npm 用户生效 |
| 2026-10-29 | [开源到 GitHub（脱敏单提交快照）](./2026-10-29-24-open-source-github.md) | 公开仓库 https://github.com/doyzhengdev/zcode-idea（181 文件、单提交 `d4306cc`、Apache-2.0）；新增 `scripts/publish-public.mjs`（HEAD→临时 worktree→脱敏→孤儿提交→force push，默认 dry-run）；公开前核查真实 AK/SK 从未进历史，克隆后 0 泄漏 |
| 2026-10-29 | [发布 0.0.8（README / 元数据更新）](./2026-10-29-23-release-0-0-8.md) | 版本 0.0.7 → 0.0.8，插件代码不变；把 README 重写、description 与 17 个 keywords 发布到 npm（页面元数据是发布时快照）；完整包 49,965,147 bytes / sha256 `772cd01…`；npm publish 返回 202 后台处理后确认 `latest=0.0.8` |
| 2026-10-29 | [README 换成可核对表述，并列出不支持项](./2026-10-29-22-npm-readme-unsupported.md) | "99% 功能"改为"官方代码原样复用、改动约 0.04% 行（19 文件）"（实测 491 行 / 112.3 万行）；新增「明确不支持」：远程工作区、Docker、WSL/SSH、Computer Use、内置浏览器侧栏、桌面外壳类、跨窗口同步/截图；并说明隐藏入口在 IDE 里有等价做法 |
| 2026-10-29 | [README 引用官方 ZCode 仓库地址](./2026-10-29-21-npm-readme-upstream-link.md) | 开头注明基于官方源码 `zai-org/ZCode`（`packages/server` + `packages/ui`），文末加「相关链接」：官方仓库与产品主页；地址取自 `ZCODE-UPSTREAM-SYNC.md`，便于读者核对"官方功能"的说法 |
| 2026-10-29 | [优化 npm 包描述与关键词](./2026-10-29-20-npm-keywords.md) | keywords 6 → 17（补 z.ai/glm、具体 IDE 名、jetbrains-plugin/ide-plugin、ai-agent/ai-coding/coding-assistant）；description 改为"安装器 + 装的是什么 + 复用官方 server 与官方 UI"；不加入 copilot/claude-code（误导）与仓库链接（非公开）；npm 元数据是发布时快照，需下次发版生效 |
| 2026-10-29 | [README 复核修正](./2026-10-29-19-npm-readme-review.md) | 修正包型表述（当前发布完整包、无需联网，薄包才需下载，原描述会让用户误以为省流量却启动失败）；新增「注意」：勿与桌面客户端同时运行（`~/.zcode` SQLite 锁）、依赖 JCEF、首启拉 server 需几秒；`ideHost=1` 内部约束改为用户可读表述 |
| 2026-10-29 | [README 去掉第三方对比，只讲自身运行机制](./2026-10-29-18-npm-readme-self-only.md) | 删除「与其它 ZCode 插件的区别」整节（含三方对比表），避免点名同类项目；卖点收敛为"官方 server + 官方 Web UI，插件只提供底层 Node 与 IDE 自带 JCEF 内核，99% 以上是官方功能"；差异信息留在内部研究文档 |
| 2026-10-29 | [README 增加「适合谁用」](./2026-10-29-17-npm-readme-target-users.md) | 补目标用户一节：主力用 JetBrains IDE 的开发者、已在用 ZCode 的人、不想在应用间切换的人、多项目并行（单 server 多窗口） |
| 2026-10-29 | [README 区分参考项目的运行机制](./2026-10-29-16-npm-readme-vs-reference.md) | 对比拆成两类：市场套壳（DOM 注入、需自跑 dev server）与参考项目 ZC GUI（自研 React webview + spawn `zcode.cjs app-server`、stdio JSON-RPC）；本插件直接跑官方 `@zcode/server` + 官方 Web UI，插件自身只提供底层 Node 与复用 IDE 的 JCEF 内核，99% 以上功能来自官方代码（补丁面 19/23） |
| 2026-10-29 | [安装器 README 补定位与运行机制](./2026-10-29-15-npm-readme-positioning.md) | 新增「为什么还要 IDE 插件」（官方 Electron 客户端看不到项目/选区，插件把 Agent 放进代码现场）与「与同类 ZCode 插件的区别」（第三方套壳 DOM 注入 vs 自建 web-ide + 正式桥 + 自管 server/runtime，补丁面 19/23）；「实现原理」改为运行机制图（JCEF ↔ server ↔ agent、双向桥、单 server 固定端口、runtime 五级解析） |
| 2026-10-29 | [精简安装器 README](./2026-10-29-14-npm-readme-simplify.md) | `scripts/npm/README.md` 压到三节：功能、实现原理（ASCII 流程图）、安装与升级仅说明由 agent 执行；手动命令/参数/排障移到 `--help` 与变更记录，避免多处过期 |
| 2026-10-29 | [发布 0.0.7（安装器进程/权限修复）](./2026-10-29-13-release-0-0-7.md) | 版本 0.0.6 → 0.0.7，插件代码不变；完整包 49,965,149 bytes / sha256 `fff7b11…`；随包交付树杀、残留 node 进程清理、UAC 提权（内联 EncodedCommand，规避执行策略）三项修复；本地 `--zip` 安装验证 + 远端清单/包核验通过；npm 已发 0.0.7 |
| 2026-10-29 | [安装器权限不足时自动 UAC 提权强杀](./2026-10-29-12-installer-uac-elevation.md) | 普通终端 `taskkill` 遇到管理员 IDE 会「拒绝访问」：新增 `isWindowsElevated` 提前提示、按需弹 UAC 提权强杀；强杀脚本用 `-EncodedCommand` 内联传入而不落地 .ps1，规避 `ExecutionPolicy Restricted` 与组策略；实测 Restricted 下 exit 0 且占位进程被清；97 用例全绿 |
| 2026-10-29 | [安装器改为树杀并清理占用插件目录的残留进程](./2026-10-29-11-installer-kill-process-tree.md) | 关闭 IDE 加 `/T` 连子进程、强制结束改按 pid 并在失败时提示管理员权限；新增"命令行引用 plugins/zcode-ide 的 node 进程"清理（IDE 退出后残留的 server/agent/远控桥会锁目录），解压遇 EBUSY/EPERM 自动清理重试；4 个单测 + 真实占位进程验证；README 补手动 taskkill 命令 |
| 2026-10-29 | [发布 0.0.6 完整包，修复其他机器"运行时下载失败"](./2026-10-29-10-release-0-0-6-full-package.md) | 薄包的 runtime 下载链路实际未接通：默认地址是 `https://cdn.example.com/` 占位符、CDN 上 runtime 对象 404、只有 HTTP 测试域名（插件拒绝非 HTTPS）、本地 build/runtime 与内置 baseline sha 不一致；`RuntimeManifest.PLUGIN_VERSION` 还是硬编码 0.1.0。改用 `--bundle-runtime` 发完整包（47.6MB，内置 runtime），安装器识别为完整包；本地 `--zip` 安装验证 + 远端清单/包核验通过，npm 已发 0.0.6 |
| 2026-10-29 | [发布 0.0.5（安装器 update 子命令）](./2026-10-29-9-release-0-0-5.md) | 版本 0.0.4 → 0.0.5，插件代码不变；构建 3,833,361 bytes / sha256 `7149499…`；用打包后的 tarball 实跑 `update --zip` 验证安装；上传七牛并发布 `zcode-idea@0.0.5`；版本化清单与 zip 核验一致，稳定指针仍被 CDN 缓存压在 0.0.4（域名级缓存覆盖对象头） |
| 2026-10-29 | [安装器新增 update 子命令](./2026-10-29-8-npm-installer-update-command.md) | `npx zcode-idea update` = `--all --yes --force`；未知命令按用法错误退出；新增 2 个解析级用例 + 1 个端到端用例（首次安装 / 普通二次跳过 / update 二次强制重装），89 用例全绿；文档强调 `@latest`（安装器按自身版本读 `<version>/manifest.json`）；需发 0.0.5 才对 npm 用户生效 |
| 2026-10-29 | [发布 0.0.4（含索引期可用修复）](./2026-10-29-7-release-0-0-4.md) | 版本 0.0.3 → 0.0.4（根 package.json / npm 包 / lock 同源）；构建产物 3,833,367 bytes、sha256 `f98bcf36…`；`npm pack` 32,649 bytes 并用 `--zip` 本地安装验证；`--apply --skip-build --push --npm --allow-http` 上传七牛 5 个对象并发布 `zcode-idea@0.0.4`；发布后核验版本化清单、稳定指针与 zip 一致；仍使用七牛 HTTP 测试域名 |
| 2026-10-29 | [远控自动恢复改为索引结束时补试](./2026-10-29-6-remote-bridge-retry-after-indexing.md) | `DumbAware` 让恢复提前到索引期后，固定 `8s + 6×10s` 窗口常整段落在 dumb mode 内，失败即打 `gave up` 并在本会话永久停止（日志 15:15:27→15:16:21 实证）；改为订阅 `DumbService.DUMB_MODE`，索引结束补试并允许后续每次 dumb 退出重试，加并发闸与 30s 最小间隔；成功路径不变 |
| 2026-10-29 | [工具窗口声明 DumbAware，修复索引期间面板不可用](./2026-10-29-5-ide-toolwindow-dumb-aware.md) | 根因是平台 `ToolWindowSetInitializerKt.beanToTask` 用 `DumbService.isDumbAware(factory)` 决定 `canWorkInDumbMode`，false 时 `ToolWindowImpl` 用 `DumbService.wrapGently` 把整块 content 换成 `DumbUnawareHider`（"not available until indexes are built"）；CodeBuddy 反编译确认其 `ToolWindowHelper implements ToolWindowFactory, DumbAware` 且全 jar 无任何 DumbService/索引等待代码；插件侧补 4 个 `DumbAware` 标记（工具窗 + 3 个启动活动），桥/面板不依赖 PSI 所以索引期安全；构建通过，实机待重启验证 |
| 2026-10-29 | [插件侧补偿 JCEF 丢失的光标形状](./2026-10-29-4-ide-cursor-sync.md) | out-of-process JCEF 不转发 `RenderHandler_OnCursorChange`，整页指针恒为箭头；新增独立 `JBCefJSQuery` + 注入脚本，页面按 40ms 采样 `pointermove` 上报 `getComputedStyle().cursor`，Kotlin 映射成 AWT 光标设到 JCEF 组件；`pointerleave`/失焦复位；不改全局 registry；实机确认光标恢复 |
| 2026-10-29 | [IDE 内分割线悬停高亮补成品牌蓝](./2026-10-29-3-ide-splitter-hover-highlight.md) | 平台 class 只由 Electron 入口挂载，IDE 里 `platform-*-desktop:after:bg-resize-handle` 永不命中，拖拽线悬停回退成 15% 灰；只补 `::after` 颜色（`[data-separator]` + `[data-testid="resizable-handle"]`），不挂平台 class（会同时带出窗口按钮/标题栏安全区/图片预览浮层偏移）；CDP 实测由 `oklab(0.87 0 0 / 0.15)` 变 `oklch(0.746 0.16 232.661)`；已替换安装态 `runtime/web` 并重启验证，用户实机确认蓝线出现 |
| 2026-10-29 | [补丁面收敛 22 → 19](./2026-10-29-2-patch-budget-converge-22-to-19.md) | 全量审查 22 个官方补丁的可收敛性：`App.tsx` 还原（纯类型收紧零行为差异，对上游 0 diff）、2 个测试用例迁到 `*.ide.test.ts` 新文件（官方 vitest include 天然发现，新旧全绿 19 passed），**修改 19 / 预算 23（余 4）**；评估后不做：WorkspaceHeader 三件套（需牺牲 ➕ 或 DOM 注入）、entry-http 收敛（需复刻 200 行装配）；保留 16 个为拦截点在官方组件树内/无能力位/行为修复类，盘符缺陷建议反馈上游 |
| 2026-10-29 | [IDE 选区发送改走官方「代码评论加入对话」事件](./2026-10-29-ide-selection-official-code-comment.md) | 选区推送派发官方 `zcode:code-comment-add-to-chat`（代码预览选区评论同链路），引用以 composer 上下文附件挂输入框上方，**不再覆盖草稿**，发送时官方序列化 File/Lines/Selected text/Comment 块；实测确认 `SessionPane.focused` 是分屏 pane 语义（单面板恒 true）而非输入框焦点，官方事件恒被消费，**`SessionPane` 补丁还原为上游原状，补丁面 22/23（余 1）**；`selectedText` 维持空串（不发原文设计），官方源码净减 1 补丁 |
| 2026-10-28 | [IDE 右键发送改走官方「加入对话」事件](./2026-10-28-ide-files-to-input-official-add-to-chat.md) | `filesToInput` 派发官方 `WORKSPACE_FILE_ADD_TO_CHAT_EVENT`（与桌面端文件树右键/拖拽同链路），面板聚焦时引用追加到输入框末尾，未聚焦回退官方 `prepend-if-missing` 兜底不丢消息；**官方源码零改动**（过程中实现的 insert-at-cursor 3 文件补丁按用户底线原则全部还原，预算回 23），AGENTS.md 红线 1 强化「尽量不改官方源码是底线原则，优先级高于任何需求」；官方事件链路实机验证聚焦/未聚焦/多文件场景 |
| 2026-10-26 | [安装器改读版本化清单](./2026-10-26-12-versioned-manifest.md) | 安装器按 npm 包版本读取 `<source>/<version>/manifest.json`，不再读稳定指针的旧缓存；清单版本与 npm 版本不一致直接失败；发布脚本硬校验仓库根/npm 版本一致，并新增版本化 manifest.sig/json 上传（稳定指针保留兼容旧版）；86 单测全绿；0.0.3 完整包与版本化清单已上传，npm 0.0.3 已发布，远程 npx 安装验证通过 |
| 2026-10-26 | [安装器 runtime 提示按实际包类型输出](./2026-10-26-11-installer-runtime-hint.md) | 用 `hasRuntime` 区分完整包/薄包，不再输出二选一文案；提示移到启动分支之前，`--no-launch` 也打印；npm 独立版本升至 `0.0.2` 并发布 |
| 2026-10-26 | [七牛 CDN 缓存：内容寻址 + 缓存头修正与告警](./2026-10-26-10-qiniu-cdn-cache.md) | 上传字段修正为 `x:Cache-Control`；实测域名缓存规则仍覆盖对象头（测试域名固定 1 年、刷新 404），manifest 更新可能延迟；zip 已内容寻址避免清单/包错配；新增上传后实际缓存头检测告警；文档说明可在 CDN 控制台对 manifest/sig 设 TTL=0 或发布后刷新 |
| 2026-10-26 | [插件版本改为跟随仓库根 package.json](./2026-10-26-9-plugin-version-source.md) | 根 `package.json` 改为 `0.0.1` 并成为插件版本唯一来源；`release.mjs` 构建自动读取并传 `-PpluginVersion`；npm 包版本独立（`scripts/npm/package.json`），不跟随；移除旧降级拦截；实测产物 jar 版本 `0.0.1`，安装器仍从七牛 manifest 读取最新可用版本 |
| 2026-10-26 | [npm 包改发官方 registry](./2026-10-26-8-npm-public-registry.md) | `publishConfig` 与 `release.mjs` 默认 registry 改为 `https://registry.npmjs.org/`；`zcode-idea@0.0.1` 已发布（36.5KB，latest）；全新 cache `npx zcode-idea --check --all` 验证通过；公网包默认插件源仍是七牛 HTTP 测试域名，正式对外前需换 HTTPS |
| 2026-10-26 | [npm 安装器新增 `--clean-cache`](./2026-10-26-7-plugin-cache-prune.md) | 新增 `prunePluginCache` 与 `--clean-cache`：安装成功后只清理 sha256 命名的旧缓存 zip 与 `.part`，保留本次版本（`--zip` 按本地包 sha256 保留）；全部失败跳过、清理异常只告警；`--check`/`--dry-run` 只读；新增 5 单测 + 4 个 CLI 端到端用例 |
| 2026-10-26 | [发布脚本合并为 `scripts/release.mjs`](./2026-10-26-6-release-script-merge.md) | 三个发布脚本合并为一条命令；新增 `--build-only` 与根 npm scripts（一键发布/插件打包/本地 npx 强制更新）；zip 改内容寻址 `<version>/zcode-ide-<version>-<sha12>.zip`，避免同版本覆盖时边缘旧缓存与清单错配；HEAD 对账重试 3 次；84 单测全绿；JDK 21 真实构建、七牛新前缀真实上传与本地强制更新均验证（版本源后来改为仓库根 package.json，见第 9 篇） |
| 2026-10-26 | [npm 安装器改为七牛 CDN 分发](./2026-10-26-5-npm-installer-cdn-distribution.md) | Nexus 上传 49MB 超时，npm 包瘦身到 33KB 只留代码；插件 zip/manifest 走七牛，Ed25519 验签 + sha256；新增 `--check/--force/--source/--zip/--allow-http`、版本对比、缓存与重试；74 单测全绿；七牛真实上传（49MB/9.3s）后本机 `npx` 安装并成功加载插件，`npm publish` 按要求未执行 |
| 2026-10-26 | [npm 安装器：安装目录写探针与帮助文案修正](./2026-10-26-4-npm-installer-write-probe.md) | 用真实创建/删除临时文件替代不可靠的 `fs.access(W_OK)`，`--all` 不再选中不可写的 Program Files 安装目录；`--no-launch` 帮助去掉误导性的 `(default: true)`；45 单测全绿 |
| 2026-10-26 | [npm 安装器 `zcode-idea`](./2026-10-26-3-npm-installer.md) | 新增 `npx zcode-idea`：跨平台发现 IDE、校验包完整性、关闭对应进程、删旧目录解压、重新启动；38 个单测全绿，真实临时目录安装与幂等重装通过，未 publish |
| 2026-10-26 | [修复 web-ide 的 vite.config.ts 类型报错](./2026-10-26-2-web-ide-tsconfig-vite-config.md) | `web-ide/tsconfig.json` 的 `include` 补上 `vite.config.ts`，消除游离文件退回 node10/commonjs 导致的 TS2307 / TS1343 |
| 2026-10-26 | [修复 IDE 内 Markdown 代码块正文空白](./2026-10-26-web-ide-diffs-worker-treeshake.md) | `@pierre/diffs` worker 被摇成 0B，web-ide worker 子构建关闭摇树 |
| 2026-10-25 | [薄插件 + ZCode/Node 运行时分发](./2026-10-25-5-thin-plugin-runtime-distribution.md) | 插件 51MB → 3.8MB 薄包，runtime 改七牛 manifest 分发：按需下载（续传/校验/zip-slip 防护/跨进程锁）、后台检查更新（Ed25519 签名 + 24h 节流）、pending 切换与回滚、设置页、CI 打包/签名/发布开关；`-PbundleRuntime=true` 保留完整包；124 单测全绿，实机矩阵待验 |
| 2026-10-25 | [复审加固：远控桥异常兜底、并发串行化与类型检查门槛](./2026-10-25-4-ide-remote-review-hardening.md) | 桥进程异常不再退出、并发开桥不再泄漏连接；ci-build 补桥构建与 typecheck（原会必挂）；桥包新增 tsconfig/shims/typecheck 脚本；修正文档过期数字 |
| 2026-10-25 | [停用拉常驻进程的官方插件与 MCP](./2026-10-25-3-ide-plugin-mcp-disabled.md) | `~/.zcode/cli/config.json` 停用 7 插件 + 2 MCP；3 窗口进程从 26 个 node / 3.0GB 降至 5 个 / 1.06GB；含"需要时再启动"的恢复方式 |
| 2026-10-25 | [修正远控桥 workspaceKey，消除重复 agent](./2026-10-25-2-ide-remote-workspace-key-dedup.md) | server 按字面字符串派生 agent，桥下发正斜杠路径导致同一项目两套 agent；新增 `workspace-keys.ts` 统一判定 + 回归测试，3 窗口实测无重复 |
| 2026-10-25 | [IDE 插件 Web 远控：复用官方 relay device 桥](./2026-10-25-ide-web-remote-control.md) | 新增 `packages/ide-remote-bridge`，复用 desktop relay transport + client 分片适配，把手机 `/remote/v4` 的 RPC 转发到本地 server；插件侧只加桥进程与三个桥方法 |
| 2026-10-25 | [文档体系重构与强制变更记录机制](./2026-10-25-docs-overhaul.md) | AGENTS 入口重写、docs 按类型分类、新增项目地图与宿主差异全清单、README 重写、新增变更记录规范与自检脚本 |
