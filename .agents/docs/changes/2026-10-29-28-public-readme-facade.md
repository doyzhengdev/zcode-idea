# 2026-10-29 · 公开仓库门面：截图、徽章、英文 README、Issue 模板

- **范围**：文档与公开仓库门面（`README.md`、`README.en.md`、`docs/images/`、`.github/ISSUE_TEMPLATE/`）
- **触发**：用户要做"赚 star"的 P0 项：补齐门面（截图、一行安装、英文版、Issue 模板）
- **提交**：working tree

## 改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `README.md` | 重写 | 首屏改为：4 个徽章（npm 版本/下载量/许可证/JetBrains）→ 截图 → 一句话定位 → `npx zcode-idea@latest update` → 为什么是 IDE 插件 → 功能表 → 明确不支持 → 环境要求 → 构建（保留原开发章节）→ 相关链接 → 非官方声明 |
| `README.en.md` | 新增 | 英文版（结构同上，精简） |
| `docs/images/panel.png` | 新增 | 从真实 IDE 窗口截取的侧栏面板图（715×830，裁掉标签栏、编辑器、状态栏与账号区） |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | 新增 | 必填：插件版本、IDE 与版本、OS、问题类型、复现步骤、日志；勾选"已升级到最新"和"未与桌面端同时运行" |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | 新增 | 问题场景 / 期望效果 / 涉及区域 |
| `.github/ISSUE_TEMPLATE/config.yml` | 新增 | 引导 ZCode 产品问题去上游仓库、安装说明去 npm |

## 截图怎么来的（以及踩的坑）

从本机真实窗口（`build/dumb-mode.png`）裁剪，而不是摆拍：

- 第一版 `hero.png` 用了整个 IDE 窗口，但项目树顶部暴露了 `E:\work\doyzheng\zcode-ide`
  个人路径，**已删除**；
- 最终只保留右侧面板区域（欢迎页 + 输入框），并裁掉左下角账号区，无任何个人信息。

## 验证

- `node scripts/publish-public.mjs --apply` 推送后克隆检查：`docs/images/panel.png`、
  `README.en.md`、`.github/ISSUE_TEMPLATE/*` 均存在，公开 README 首屏为新版；
- 快照提交 `2be4a4c`（首次发布后发现只提交了工作区、HEAD 未含新文件，已重新发布）。

## 风险 / 后续

- 徽章里的 downloads 统计来自 npm，量小时显示不好看，但长期正向。
- Marketplace 上架仍需人工：JetBrains 账号后台创建插件、上传 zip、填写描述与截图
  （可直接复用本目录的 `panel.png`）。
