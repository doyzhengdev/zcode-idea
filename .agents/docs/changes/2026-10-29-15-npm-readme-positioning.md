# 2026-10-29 · 安装器 README 补定位与运行机制

- **范围**：`scripts/npm/README.md`（文档）
- **触发**：用户要求把"为什么有桌面端还要 IDE 插件""与同类 ZCode 插件的区别"写进文档；
  并说明"实现原理"指的是**插件运行机制**，不是安装流程
- **提交**：working tree

## 改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/README.md` | 重写 | 新增「为什么还要一个 IDE 插件」「与其它同类 ZCode 插件的区别」；把「实现原理」从安装器七步流程换成**运行机制**（IDE 内 JCEF ↔ 本机 server ↔ agent、双向桥、单 server/固定端口、runtime 五级解析、`ideHost=1` 门控）；功能一节改为插件能力清单；安装/升级仍只说明由 agent 执行 |

## 为什么改

原 README 的"实现原理"写的是安装器怎么装（取清单→发现→关闭→解压），对使用者没有解释
插件本身怎么跑；而"为什么在官方客户端之外还要做 IDE 插件"正是产品的核心卖点，此前只散落
在 `.agents/docs` 内部文档里，没有被用户看到。

对比结论来自仓库内已有分析，不是临时发挥：

- 同类插件 = 第三方套壳（JCEF + 运行时 DOM 注入、需用户自跑 dev server、63KB），
  见 [`research/zcode-web-plugin-analysis.md`](../research/zcode-web-plugin-analysis.md)；
- 本插件 = 自建 web-ide（官方 UI 源码）+ 正式桥 + 自管 server/runtime，
  见 [`architecture/PROJECT-MAP.md`](../architecture/PROJECT-MAP.md) 与 `AGENTS.md` 项目地图。

文中数字已核对：桥方法 `IdeCommand` 分支 15 个（`IdeBridge.kt`）；
官方源码修改面 `node scripts/patch-budget.mjs` → **19 / 预算 23**。

## 验证

纯文档改动，未运行代码；`node scripts/patch-budget.mjs` 与 `grep` 用于核对文中数字。

## 风险 / 后续

- 数字（15 个桥方法、19 个补丁文件）会随开发变化，更新时需同步这一节。
- 对外文案里对同类插件的描述保持"机制差异"，不点名、不评价其质量。
