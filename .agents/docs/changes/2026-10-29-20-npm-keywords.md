# 2026-10-29 · 优化 npm 包描述与关键词

- **范围**：`scripts/npm/package.json`（发布元数据）
- **触发**：用户要求优化 keywords，提升 npm 搜索命中
- **提交**：working tree

## 改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/package.json` | 修改 | `keywords` 从 6 个扩到 17 个（补 z.ai / glm / 具体 IDE 名 / jetbrains-plugin / ide-plugin / ai-agent / ai-coding / coding-assistant）；`description` 改为说明"安装器 + 装的是什么、复用官方 server 与官方 UI" |

关键词分组：

- 产品/模型：`zcode`、`z.ai`、`glm`
- 宿主：`jetbrains`、`intellij`、`intellij-idea`、`idea`、`webstorm`、`pycharm`、`goland`、`clion`
- 类型：`jetbrains-plugin`、`ide-plugin`、`installer`
- 意图：`ai-agent`、`ai-coding`、`coding-assistant`

## 为什么改

原关键词只有 6 个泛词（`plugin`、`installer` 等），用户按"WebStorm/PyCharm/GLM/AI 编程"
搜索基本命中不到。npm 搜索权重主要看包名、描述、关键词与 README，所以同时把描述补成
"装的是什么 + 复用官方 server 与官方 UI"，既是搜索语料也是价值说明。

不加入的：`copilot`、`claude-code`（属于其它产品，容易误导）；仓库链接（gitee 仓库非公开，
`curl` 返回 403，不放进 `repository`）。

## 验证

- `package.json` JSON 解析通过；`npm pack --dry-run` 正常（16 文件，38.9 kB，README 变大所致）。
- 未发布：npm 上的描述/关键词/README 是**发布时快照**，改动要等下一次 `npm publish` 才生效。

## 风险 / 后续

- 关键词不宜继续堆砌，17 个已覆盖主要搜索词；再加会显得像堆词。
- README 与本文件的多轮改动同样要等下次发版才会显示在 npm 页面。
