# 2026-10-29 · README 区分参考项目的运行机制

- **范围**：`scripts/npm/README.md`（文档）
- **触发**：用户指出参考项目 `zcode-jetbrains-plugin` 也介绍了运行机制，需要讲清差异；
  并强调本插件 99% 以上是官方功能、自身只提供 Node 与 IDE 浏览器内核
- **提交**：working tree

## 改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/README.md` | 修改 | 「与其它 ZCode 插件的区别」改为两类对比：市场套壳（DOM 注入、需自跑 dev server）与参考项目 ZC GUI（自研 React webview + spawn `zcode.cjs app-server`、stdio JSON-RPC、实现 browser-use 宿主协议）；表格改为按"界面来源 / 后端形态 / 官方功能覆盖 / IDE 能力 / Node 与 runtime"逐项对比；补一句"插件自身只提供底层 Node + 复用 IDE 浏览器内核（JCEF），99% 以上功能来自官方代码" |

## 为什么改

参考项目的 README 在「工作原理」里明确写了：`node zcode.cjs app-server` + stdio JSON-RPC +
自研 webview，这与本插件"直接跑官方 `@zcode/server` + 官方 Web UI 源码"是两条不同的路线。
原来的对比只写了"第三方套壳"，没有覆盖这类"自研界面的 ZCode 客户端"，读者容易把两者混为
一谈。同时用户明确要求突出卖点：**想体验 ZCode 官方功能，就该用这个插件**。

事实核对（均来自仓库内证据，不是外部推断）：

- 参考项目机制：其 README「工作原理」节（子进程 + JSON-RPC + 自研 webview + browser-use 宿主）。
- 本插件桥方法：`IdeBridge.kt` 分支数 15。
- 官方源码补丁面：`node scripts/patch-budget.mjs` → 修改 19 / 预算 23，新增 17。

## 验证

纯文档改动；数字用 `grep` 与 `patch-budget.mjs` 核对。

## 风险 / 后续

- 对比只描述机制差异，不评价第三方项目质量；引用其仓库链接，不做功能贬损。
- 19/23、15 这些数字随开发变化，更新文档时需同步。
