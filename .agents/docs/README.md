# .agents/docs — 文档索引

> 本目录是项目的全部技术文档与会话纪要，按文档类型分目录存放。Agent 入口是 [`../../AGENTS.md`](../../AGENTS.md)，本文件是它指向的文档地图。
> 事实优先级：**当前代码与构建脚本 > [`../../README.md`](../../README.md) > [`architecture/HANDOFF.md`](./architecture/HANDOFF.md) > 会话纪要（[`sessions/`](./sessions/)）**。

## 目录结构

```
.agents/docs/
├── README.md          # 本文件，索引
├── architecture/      # 系统怎么工作：架构、实现细节、宿主适配
├── development/       # 怎么改代码：不变量、改动落点、环境调试、当前状态
├── build/             # 怎么构建发布：构建部署、CI
├── upstream/          # 怎么跟上游走：补丁面、同步流程
├── research/          # 调研与评审
├── changes/           # 变更记录（每次改源码必须新增一篇）
└── sessions/          # 会话纪要（按日期）
```

## 1. 按任务选文档

| 你要做什么 | 先读 |
|---|---|
| 第一次接触项目 | [`architecture/PROJECT-MAP.md`](./architecture/PROJECT-MAP.md) → [`architecture/ARCHITECTURE.md`](./architecture/ARCHITECTURE.md) → [`build/BUILD-AND-DEPLOY.md`](./build/BUILD-AND-DEPLOY.md) |
| 改 Kotlin / plugin.xml / 桥 | [`development/INVARIANTS.md`](./development/INVARIANTS.md) → [`development/WORK-MAP.md`](./development/WORK-MAP.md) |
| 改官方前端 / UI 精简 | [`development/INVARIANTS.md`](./development/INVARIANTS.md)（重点 4 / 19 / 21 / 22）→ [`development/IDE-UI-TRIMMING.md`](./development/IDE-UI-TRIMMING.md) → [`development/WORK-MAP.md`](./development/WORK-MAP.md) → [`architecture/IDE-HOST-ADAPTATION.md`](./architecture/IDE-HOST-ADAPTATION.md) |
| 想知道插件与桌面客户端的功能差异 | [`architecture/IDE-VS-DESKTOP.md`](./architecture/IDE-VS-DESKTOP.md) |
| 同步上游 / 审查补丁面 | [`upstream/CHANGES-VS-UPSTREAM.md`](./upstream/CHANGES-VS-UPSTREAM.md) → [`upstream/ZCODE-UPSTREAM-SYNC.md`](./upstream/ZCODE-UPSTREAM-SYNC.md) |
| 实机排查（日志 / CDP / 截图） | [`development/ENVIRONMENT.md`](./development/ENVIRONMENT.md) |
| 看进度与待办 | [`development/STATUS.md`](./development/STATUS.md) |
| 发版 / CI | [`build/CI.md`](./build/CI.md) → [`build/BUILD-AND-DEPLOY.md`](./build/BUILD-AND-DEPLOY.md) |
| 薄插件 / runtime 分发 / 自动更新 | [`build/RUNTIME-DISTRIBUTION.md`](./build/RUNTIME-DISTRIBUTION.md)（**已实施 2026-10-25**，落地记录见其 §14） |

## 2. architecture/ — 架构与实现

系统由哪些部分组成、运行时怎么跑、IDE 宿主如何适配。

| 文档 | 作用 |
|---|---|
| [`PROJECT-MAP.md`](./architecture/PROJECT-MAP.md) | **文件级地图**：每个文件的职责与改动时机、12 个桥方法、改动边界；定位"改哪里"先看这篇 |
| [`ARCHITECTURE.md`](./architecture/ARCHITECTURE.md) | 项目定位、两个仓库的关系、本仓库目录结构、运行时架构与两条通道（HTTP/WS + JBCefJSQuery） |
| [`IDE-VS-DESKTOP.md`](./architecture/IDE-VS-DESKTOP.md) | **插件 vs 官方桌面客户端全清单**：左侧栏/头部/草稿/对话/文件/设置/窗口/运行时的新增、删除、修改、不支持逐项对照 |
| [`HANDOFF.md`](./architecture/HANDOFF.md) | 主技术文档：架构、4.x 逐项实现细节（桥、主题、端口、identity、ideHost 精简、文件打开等）、构建、已知问题、决策记录。内容最全，部分路径为迁移前旧写，以代码为准 |
| [`IDE-HOST-ADAPTATION.md`](./architecture/IDE-HOST-ADAPTATION.md) | IDE 宿主适配原则：`isDesktop` 的本质与落点、记忆/MCP 的存储机制、JCEF+CDP 验证法、磁盘写零事故记录 |

## 3. development/ — 开发规范与操作

改代码前必读的约束、按任务定位改动点、实机调试方法、当前状态。

| 文档 | 作用 |
|---|---|
| [`INVARIANTS.md`](./development/INVARIANTS.md) | 24 条不变量与踩坑清单，改代码前必读 |
| [`WORK-MAP.md`](./development/WORK-MAP.md) | 常见任务 → 改动落点，含取舍准则与改动位置准则 |
| [`IDE-UI-TRIMMING.md`](./development/IDE-UI-TRIMMING.md) | IDE 形态 UI 裁剪手册：CSS 优先的判据、隐藏入口后的占位检查、产物验证流程 |
| [`ENVIRONMENT.md`](./development/ENVIRONMENT.md) | 工具链版本、镜像、日志排查、CDP 观测桥与真实 UI 点击 |
| [`STATUS.md`](./development/STATUS.md) | 已完成项与未完成清单 |

## 4. build/ — 构建与发布

| 文档 | 作用 |
|---|---|
| [`BUILD-AND-DEPLOY.md`](./build/BUILD-AND-DEPLOY.md) | 版本锁定、CI/发版、Kotlin-only 与前端改动两条构建路径、本机部署 |
| [`CI.md`](./build/CI.md) | 单入口 `ci-build.mjs`、Windows 流水线、缓存与发版顺序 |
| [`RUNTIME-DISTRIBUTION.md`](./build/RUNTIME-DISTRIBUTION.md) | 薄插件 + ZCode/Node 运行时分发（七牛云）、manifest 签名、首次下载、自动更新与回滚；**已实施（2026-10-25）**，§14 为实施落地记录与偏差表 |

## 5. upstream/ — 上游同步

| 文档 | 作用 | 时效性 |
|---|---|---|
| [`CHANGES-VS-UPSTREAM.md`](./upstream/CHANGES-VS-UPSTREAM.md) | 相对上游 `3c5b2276` 的逐文件改动清单（23 修改 / 3 新增 / 预算 23）、冲突分级、同步记录；**每次同步必须更新** | **当前**，审查代码/同步上游前必读 |
| [`ZCODE-UPSTREAM-SYNC.md`](./upstream/ZCODE-UPSTREAM-SYNC.md) | fork 拓扑、分支模型、补丁清单、补丁预算、同步上游的完整步骤与冲突高发区 | 同步上游前必读 |

## 6. research/ — 调研与评审

| 文档 | 作用 | 时效性 |
|---|---|---|
| [`OPTIMIZATION-REVIEW-2026-10-24.md`](./research/OPTIMIZATION-REVIEW-2026-10-24.md) | 性能与架构优化评审（含未落地的 3.5 消息缓冲修法） | 待办来源 |
| [`zcode-web-plugin-analysis.md`](./research/zcode-web-plugin-analysis.md) | 市场同类插件（JCEF + DOM 注入）反编译分析与逐项对照 | 调研资料，**不是**本项目架构说明 |

## 7. sessions/ — 会话纪要（历史记录，路径多为旧结构）

| 文档 | 内容 | 时效性 |
|---|---|---|
| [`SESSION-SUMMARY.md`](./sessions/SESSION-SUMMARY.md) | 2026-10-23 首轮会话：需求演进、技术选型、bug 历史 | 历史背景 |
| [`SESSION-2026-10-24.md`](./sessions/SESSION-2026-10-24.md) | Windows 盘符翻倍 bug（`E:\E:\`）根因链、目录重构决策、fork 推 Work 方案 | 历史（身份修复仍现行） |
| [`SESSION-2026-10-24-2.md`](./sessions/SESSION-2026-10-24-2.md) | 侧栏/头部精简、右键发送文件引用、会话内点文件打开编辑器 | 历史（相关行为仍现行） |
| [`SESSION-2026-10-24-3.md`](./sessions/SESSION-2026-10-24-3.md) | 仓库迁到 `E:\work`、server 改 local 宿主形态、665 条会话迁移 | 历史 |
| [`SESSION-2026-10-24-4.md`](./sessions/SESSION-2026-10-24-4.md) | `workspace_key` 归一化与历史任务自愈 | 历史（修复脚本仍可用） |
| [`SESSION-2026-10-24-5.md`](./sessions/SESSION-2026-10-24-5.md) | 多窗口共享单 server（`ZCodeServerManager` + URL `ideWorkspace`）、端口/token 持久化、重启广播 | **当前**，多窗口行为以它为准 |

## 8. 文档换算表（遇到旧路径时）

| 旧写法 | 当前含义 |
|---|---|
| `E:/github/zcode-ide` | `E:/work/zcode-ide` |
| `E:/github/ZCode` 或 `E:/work/ZCode` | `vendor/ZCode`（fork 工作副本，2026-10-24 移入） |
| `zcode-ide/src/...` 或 `zcode-ide/build/...` | 根目录 `src/...` / `build/...`（已扁平化） |
| `./gradlew :zcode-ide:buildPlugin` | `./gradlew buildPlugin` |
| 根目录 `ZCode/` 或 `E:/work/ZCode` | `vendor/ZCode` |
| `runtime/`（源码树） | `dist/`（安装态仍叫 `runtime/`） |
| `docs/xxx.md` | `.agents/docs/<分类>/xxx.md`（2026-10-25 迁入 `.agents/docs/` 并按类型分类；`README.md` 仍在根） |
| `.agents/docs/xxx.md` | `.agents/docs/<分类>/xxx.md`（2026-10-25 分类） |

## 9. 文档维护约定

改动落地时同步更新对应文档，避免"代码对了、文档过期"：

| 改动类型 | 必须更新 |
|---|---|
| **任何源码/构建输入改动** | [`changes/`](./changes/) 新增一篇（模板见其 README）；提交前跑 `node scripts/check-change-log.mjs` |
| 新增/删除官方源码补丁、同步上游 | [`upstream/CHANGES-VS-UPSTREAM.md`](./upstream/CHANGES-VS-UPSTREAM.md)（§0 / §3 / §8） |
| 构建顺序、脚本、产物路径变化 | [`build/BUILD-AND-DEPLOY.md`](./build/BUILD-AND-DEPLOY.md)、[`build/CI.md`](./build/CI.md) |
| 新增文件、模块职责变化、桥方法或消息 op 增删 | [`architecture/PROJECT-MAP.md`](./architecture/PROJECT-MAP.md) |
| 新的不变量/踩坑（尤其是导致过端到端故障的） | [`development/INVARIANTS.md`](./development/INVARIANTS.md) |
| 任务落点或取舍准则变化 | [`development/WORK-MAP.md`](./development/WORK-MAP.md) |
| 新增调试手段、环境或网络变化 | [`development/ENVIRONMENT.md`](./development/ENVIRONMENT.md) |
| 功能完成或有新的已知缺口 | [`development/STATUS.md`](./development/STATUS.md) |
| 架构、端口、身份等机制变化 | [`architecture/ARCHITECTURE.md`](./architecture/ARCHITECTURE.md)，必要时补 [`architecture/HANDOFF.md`](./architecture/HANDOFF.md) |

唯一不可省的是第一行：**官方源码补丁的账必须记**。其余按影响面更新，宁可补一行，不要留下过期数字。

## 10. 相关入口

- [`changes/README.md`](./changes/README.md)：变更记录规范、模板与索引；每次改源码必须新增一篇
- [`../../README.md`](../../README.md)：项目定位、目录布局、构建/运行/部署、已实现与已知问题
- [`../../vendor/README.md`](../../vendor/README.md)：`vendor/ZCode` 工作副本的用途、`zcode.lock` 字段与 `bootstrap.mjs` 用法
- [`../skills/deploy-zcode-plugin/SKILL.md`](../skills/deploy-zcode-plugin/SKILL.md)：本机打包/部署/验证/排错流程
