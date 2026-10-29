# 2026-10-29 · README 增加「适合谁用」

- **范围**：`scripts/npm/README.md`（文档）
- **触发**：用户要求强调"这款插件非常适用使用 JetBrains IntelliJ IDEA 的用户"
- **提交**：working tree

## 改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/README.md` | 修改 | 在「与其它 ZCode 插件的区别」之后新增「适合谁用」：主力用 JetBrains IDE 的开发者、已在用 ZCode 的人、不想在应用间切换的人、多项目并行的人 |

## 为什么改

前面的章节讲的是"为什么存在""和别人有什么不同"，缺少一句"这是给谁用的"。目标用户很明确：
日常在 IDEA / WebStorm / PyCharm / GoLand 等 JetBrains IDE 里写代码、又想用 ZCode 的人。

## 验证

纯文档改动；内容与现有实现一致（同一 `~/.zcode`、单 server 多窗口、IDE 内嵌官方 UI）。

## 风险 / 后续

无。产品支持范围变化时（新增/移除某个 IDE）同步更新开头与本节。
