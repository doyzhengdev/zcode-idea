# 2026-10-29 · 安装器新增 `update` 子命令

- **范围**：`scripts/npm`（CLI、测试、README）
- **触发**：用户希望把 `npx zcode-idea@latest --all --yes --force` 简化为 `npx zcode-idea update`
- **提交**：working tree

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/bin/zcode-idea.mjs` | 修改 | 支持位置参数 `update`，等价于 `--all --yes --force`；未知命令与非 `update` 的额外参数按用法错误（退出码 2）；`--help` 增加示例与 `[update]` |
| `scripts/npm/test/cli.test.mjs` | 修改 | 新增：帮助里出现 `update` 用法、未知命令退出码 2 |
| `scripts/npm/test/cli-install.test.mjs` | 新增 | 端到端：`update` 首次安装成功；普通安装第二次判定"已是最新（跳过）"；`update` 第二次命中缓存但仍"强制重装" |
| `scripts/npm/README.md` | 修改 | 快速使用改为 `npx zcode-idea@latest update`，并解释为什么建议带 `@latest` |

## 为什么改

`--all --yes --force` 三个 flag 每次手打，且漏掉任意一个都会导致"没更新"或"停在确认提示"。
把它们收成一个词，同时保留原有 flag（`update` 只是默认值叠加，不改变显式传参的语义）。

**为什么仍建议 `@latest`**：安装器按自身 npm 版本读取清单 `<source>/<version>/manifest.json`。
不带 `@latest` 时 npx 可能复用缓存的旧安装器，于是它只会去读旧版本清单，看不到新版本 ——
这是"版本化清单"设计的必然结果，不是 bug。

## 行为变化

- `npx zcode-idea update` = 处理全部 IDE + 跳过关闭确认 + 同版本也强制重装。
- 未知子命令（如 `deploy`）直接报错退出（2），不再静默忽略位置参数。
- 原有所有 flag 与交互式流程不变。

## 验证

- `npm test`（`scripts/npm`）：89 个用例全绿（新增 3 个）。
- 实跑：`node scripts/npm/bin/zcode-idea.mjs update --zip …zcode-ide-0.0.4.zip --target <临时目录> --no-launch` → 安装成功，落地 `zcode-ide-0.0.4.jar`。
- 实跑：`node scripts/npm/bin/zcode-idea.mjs deploy --all` → `错误：未知命令：deploy`，退出码 2。

## 风险 / 后续

- **要发到 npm 才算对用户生效**：npm 版本不可覆盖，需发 0.0.5，并同步上传 `<version>/manifest.json` 与插件 zip（安装器版本 = 清单路径版本）。在发版前，`update` 只有本地/源码可用。
- 若用户直接 `npx zcode-idea update` 且 npx 缓存了旧安装器，仍会读旧清单；文档已标注 `@latest`。

## 相关

- [`2026-10-29-7-release-0-0-4.md`](./2026-10-29-7-release-0-0-4.md)
- `scripts/npm/README.md`
