# 2026-10-29 · README 引用官方 ZCode 仓库地址

- **范围**：`scripts/npm/README.md`（文档）
- **触发**：用户要求在说明文档里引用官方 ZCode 的 GitHub 地址
- **提交**：working tree

## 改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/README.md` | 修改 | 开头说明"插件基于官方源码 [`zai-org/ZCode`](https://github.com/zai-org/ZCode)，用到 `packages/server` 与 `packages/ui`"；文末新增「相关链接」：官方源码仓库 + ZCode 产品主页 |

## 为什么改

读者看到"99% 官方功能"需要一个可核对的出处；直接给上游仓库比自述更有说服力，也方便想核实的
人对照接口与行为。地址取自仓库内既有记录（`upstream/ZCODE-UPSTREAM-SYNC.md` 的
"官方上游 `https://github.com/zai-org/ZCode.git`"），不是新查的。

## 验证

纯文档改动；链接地址与 `ZCODE-UPSTREAM-SYNC.md`、根 `README.md` 一致。

## 风险 / 后续

- 上游仓库若迁移/改名，需要同步本文件与 `ZCODE-UPSTREAM-SYNC.md`。
