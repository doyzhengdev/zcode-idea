# 2026-10-25 · 文档体系重构与强制变更记录机制

- **范围**：文档（`.agents/docs/`、`AGENTS.md`、`README.md`、`vendor/README.md`）、构建脚本、本地 IDE 配置
- **触发**：用户要求入口文件 AI 化、docs 按类型分类、补充项目地图与宿主差异清单，并建立"每次改源码必须记录"的强制机制
- **提交**：working tree（未提交）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/check-change-log.mjs` | 新增 | 提交前自检：改动里出现源码/构建文件但没有 `changes/` 记录时失败；支持 `--staged`、`--base=` |

本轮**没有修改** Kotlin、`packages/web-ide`、`packages/ui`、`packages/server`、`packages/shared` 或 fork 提交。

## 文档改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `AGENTS.md` | 重写 | 从 294 行收紧为索引式入口：项目地图、开发方式（功能优先插件侧）、任务路由、10 条红线、完成标准、文档表；去掉"少改代码"的泛化表述，改为"仅官方源码最小化" |
| `.agents/docs/README.md` | 重写 | 文档索引：目录结构、按任务选文档、六个分类清单、旧路径换算表、**文档维护约定** |
| `.agents/docs/architecture/PROJECT-MAP.md` | 新增 | 文件级地图：运行时全景、插件层 12 个文件、12 个桥方法、IDE→Web 的 2 个 op、web-ide 与官方 UI 适配点、构建链、改动边界 |
| `.agents/docs/architecture/IDE-VS-DESKTOP.md` | 新增 | 与官方桌面客户端的**逐项差异全清单**：77 处标注（新增 12 / 删除 21 / 修改 24 / 不支持 12 / 相同 8），覆盖左侧栏、头部、草稿、对话、文件、设置、窗口、运行时、网络容器 |
| `.agents/docs/upstream/CHANGES-VS-UPSTREAM.md` | 重写 | 按当前 HEAD `f2f72b14` 重写：23 修改 / 3 新增 / 9 排除 / 预算 23；每个文件补"为什么改 / 修改后 / 约束与风险"；新增同步记录表与更新规则 |
| `README.md`（根） | 重写 | 面向人：能力表、环境要求、构建（bootstrap / Kotlin-only / 前端三步 / CI）、安装、架构与三条路径、使用、目录结构、已知限制、开发文档导航、上游与 fork |
| `vendor/README.md` | 补充 | 新增「在 IDE 里同时管理两个仓库」：`.idea/vcs.xml` 配置、两个 Git root、提交后的记账与 `bootstrap --update` 联动 |
| `.agents/docs/upstream/ZCODE-UPSTREAM-SYNC.md` | 更新 | 补丁清单更新为 7 个提交；锁 commit 改 `f2f72b14`；同步步骤加"先记账再打包" |
| `.agents/docs/development/STATUS.md` | 修正 | 删除重复的"重启广播未实测"；"目录链接仍打开内置树"改为"仅工作区外临时目录"；补欢迎页 ➕ 根因与上游版本现状 |
| `.agents/docs/development/WORK-MAP.md` | 修正 | 取舍准则改为"功能优先在插件侧实现"，明确只有官方原有文件需要克制 |
| `.agents/docs/development/ENVIRONMENT.md` | 补充 | 新增「多仓库 Git 管理」小节 |
| `.agents/docs/build/CI.md` | 补充 | 发版顺序加入 `patch-budget` 与更新改动清单 |
| `.agents/docs/architecture/HANDOFF.md` | 补充 | 顶部加当前文档导航，保留实现细节与历史决策 |
| `.agents/docs/architecture/IDE-HOST-ADAPTATION.md` | 补充 | 顶部指向文件级适配点与宿主差异清单 |
| `.agents/docs/sessions/SESSION-SUMMARY.md` | 补充 | 加 `docs/` 迁移注记 |
| `.agents/docs/changes/README.md` | 新增 | 变更记录规范：触发条件、命名、模板、与官方补丁清单的分工、自检命令、索引 |
| `.agents/docs/changes/2026-10-25-docs-overhaul.md` | 新增 | 本条记录 |

## 文档迁移

`docs/` 整体迁入 `.agents/docs/` 并按类型分目录（`git mv` 保留历史）：

```
.agents/docs/
├── README.md
├── architecture/   PROJECT-MAP、ARCHITECTURE、HANDOFF、IDE-HOST-ADAPTATION、IDE-VS-DESKTOP
├── changes/        变更记录（本目录）
├── development/    INVARIANTS、WORK-MAP、ENVIRONMENT、STATUS
├── build/          BUILD-AND-DEPLOY、CI
├── upstream/       CHANGES-VS-UPSTREAM、ZCODE-UPSTREAM-SYNC
├── research/       OPTIMIZATION-REVIEW、zcode-web-plugin-analysis
└── sessions/       SESSION-*
```

迁移后统一重算了 Markdown 相对链接（含锚点），并修正了 3 处因层级变化失效的链接。

## 本地 IDE 配置

| 文件 | 说明 |
|---|---|
| `.idea/vcs.xml` | 新增第二条 Git root 映射 `$PROJECT_DIR$/vendor/ZCode`，让 IDE 的 Git 工具窗口能同时管理插件仓库与 fork。`.idea/` 被 gitignore，不入库；重启 IDE 生效 |

## 为什么改

1. 原 `AGENTS.md` 294 行，混了项目说明、构建、21 条不变量、任务落点、状态；AI 每次都要整篇读，且容易把"少改代码"误解成插件侧也不能写。
2. `docs/` 平铺 13 个文件，找文档靠记忆；新旧路径混杂。
3. 没有任何文档回答"插件和官方客户端到底哪里不一样"，而左侧栏恰好是改动最密集的区域。
4. 纯 AI 开发缺少变更时间线：只有官方补丁的累积快照，没有"这次为什么改、验证到哪一步"的记录。

## 行为变化

- 运行时行为无变化。
- 开发者体验：IDE Git 工具窗口可同时看到两个仓库；agent 入口更短、路由更明确。
- 新增提交前检查：改源码但没写 `changes/` 记录时 `node scripts/check-change-log.mjs` 会失败。

## 验证

- Markdown 相对链接与锚点：全项目 152 条，0 断链（唯一报告项是 `zcode-web-plugin-analysis.md` 里的示例占位符 `./rel/path`）。
- 表格列数一致性：全部文档 0 异常。
- 补丁统计与文档数字对齐：`node scripts/patch-budget.mjs --json` = 23 修改 / 3 新增 / 9 排除 / 预算 23。
- 上游检查：2026-10-25 `git fetch upstream --tags` 成功，`upstream/main` 仍为 `3c5b2276`，0 个新提交、无新 tag。
- 修正了文档中的错误 op 名（`addPathsToComposer` → 实际的 `filesToInput`）。
- 未在真实 IDE 中验证文档改动（纯文档/脚本，无运行时影响）。

## 风险 / 后续

- 文档量增大，维护成本上升；`changes/` 规则与自检脚本是主要抓手，需要每次改动都执行。
- `HANDOFF.md`（559 行）、`research/`、`sessions/` 保留大量旧路径与旧描述，已加导航/注记，未逐句重写。
- `check-change-log.mjs` 只看插件仓库 diff，看不到 `vendor/ZCode` 内部的改动；fork 侧需要手动在记录中列出。
- 脚本尚未接入 CI，目前靠流程；若后续需要强约束，可在 `ci-build.mjs` 或 CI workflow 中调用。

## 相关

- 入口：[`../../../AGENTS.md`](../../../AGENTS.md)
- 文档索引：[`../README.md`](../README.md)
- 官方补丁快照：[`../upstream/CHANGES-VS-UPSTREAM.md`](../upstream/CHANGES-VS-UPSTREAM.md)
- 宿主差异：[`../architecture/IDE-VS-DESKTOP.md`](../architecture/IDE-VS-DESKTOP.md)
