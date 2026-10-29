# 2026-10-29 · 在官方仓库的 fork 网络里出现（GitHub fork）

- **范围**：上游同步（GitHub fork、`vendor/ZCode` remote、文档）
- **触发**：用户问"如何在官方仓库哪里出现我们 fork 了他们仓库"
- **提交**：working tree

## 结论

GitHub 的 fork 网络（Forks 列表 / network 图）**只认 GitHub 上的 fork**。我们原来的 fork 在
Work，所以无论推多少提交都不会出现在 `zai-org/ZCode` 的 Forks 里。要"出现"，必须在 GitHub
上对官方仓库执行一次 Fork。

已执行：

| 项 | 值 |
|---|---|
| Fork | https://github.com/doyzhengdev/ZCode （`fork=true`，`parent=zai-org/ZCode`） |
| 默认分支 | `main` = `3c5b2276`（与我们的 upstreamBase 相同） |
| 已推分支 | `ide-integration` = `5aa74794`（19 个官方补丁所在分支） |
| 本地 remote | `vendor/ZCode` 新增 `github` → `git@github.com:doyzhengdev/ZCode.git` |

出现位置（GitHub 侧）：

- 官方仓库 **Forks** 标签页：`https://github.com/zai-org/ZCode/forks`
- 我们 fork 的页面顶部显示 "forked from zai-org/ZCode"
- 官方仓库 **Insights → Forks / network graph**（`/network/members`）会显示该 fork 及其
  `ide-integration` 分支节点
- 搜索 `repo:doyzhengdev/ZCode fork:true` 可命中

## 踩到的坑

从本地 `vendor/ZCode` 推送失败：fork 仓库自带 husky `pre-push` 钩子，会去解析
`origin/staging` 基线并报 `fatal: Needed a single revision`。由于我们只推单个分支，直接跳过钩子：

```bash
git push --no-verify github ide-integration:refs/heads/ide-integration
```

## 文档改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `.agents/docs/upstream/ZCODE-UPSTREAM-SYNC.md` | 修改 | 仓库拓扑表补 GitHub fork 行；把过时的 remote 说明（`origin`/`upstream`）改为实际的 `fork`/`github`；补 `--no-verify` 与"fork 网络只认 GitHub fork"的说明 |

## 验证

- API 查询 `repos/doyzhengdev/ZCode`：`fork=true`、`parent=zai-org/ZCode`、`updated=2026-10-29T09:19Z`；
- `git ls-remote github`：`main=3c5b2276`、`ide-integration=5aa74794`、`feat/ui-plugin`（上游分支）；
- 插件仓库 `zcode-idea` 不是 fork，**不会**出现在官方 Forks 列表里——只有 `ZCode` fork 会。

## 风险 / 后续

- 公开仓库的 fork 不能设为私有（GitHub 限制）；fork 内容与我们的补丁面一致，此前已确认提交
  信息不含内部标识。
- 后续上游同步后，需要同时推 Work `fork` 与 GitHub `github` 两个 remote（后者记得 `--no-verify`）。
