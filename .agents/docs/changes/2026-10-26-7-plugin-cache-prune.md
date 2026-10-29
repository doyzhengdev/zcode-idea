# 2026-10-26 · npm 安装器新增 `--clean-cache` 清理旧插件包缓存

- **范围**：`scripts/npm/`（npm 安装器）、文档
- **触发**：补上 CDN 分发方案遗留的缓存增长缺口
- **提交**：working tree

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/lib/download.mjs` | 修改 | 新增并导出 `prunePluginCache({ env, keep, dryRun })`：只识别 sha256 命名的 `<64位十六进制>.zip` 与 `<64位十六进制>.zip.part`，保留 `keep` 中 sha256（大小写不敏感）对应的 zip，删除其余缓存 zip 与全部缓存 `.part`；非 sha256 命名的 `*.zip`、其它文件与子目录一律不动；目录不存在返回空结果；单个删除失败记入 `failed` 不中断；不打印日志。`dryRun` 仅扫描并返回同样的计划，不删除。 |
| `scripts/npm/bin/zcode-idea.mjs` | 修改 | 新增 `--clean-cache`：在安装汇总与启动 IDE 之后、且**至少一个目标安装成功后**执行清理，`keep` 为本次使用的 sha256（远端 manifest 的 `plugin.sha256`；`--zip` 本地模式用 `plugin.zipInfo.sha256`）；全部目标安装失败时 `warn`「安装失败，已跳过缓存清理」并保持退出码 1；清理自身异常（含 dry-run 预览）只 `warn`，不改变安装结果与退出码；`--check` 不清理也不提示；`--dry-run` 只打印一行清理预览，不删除，预览已前移到 pending 判断之前（全部目标已是最新也会打印）。 |
| `scripts/npm/test/cache-prune.test.mjs` | 新增 | 5 个单测：保留/删除/不动其它文件、目录不存在、keep 大小写不敏感、keep 为空全清、dryRun 不删除；其中第一个用例同时断言 `backup.zip`、`zcode-ide-0.1.0.zip`、`my-notes.zip.part` 等非 sha256 命名文件不被删除。用 `ZCODE_DATA_BASE_DIR` 指向临时目录隔离，测试结束清理。 |
| `scripts/npm/test/cli.test.mjs` | 修改 | `--help` 断言补充 `--clean-cache` 与对应中文说明，防止帮助文案回退。 |
| `scripts/npm/test/cli-install.test.mjs` | 修改 | 新增 4 个端到端断言：全部安装失败时跳过清理且退出码 1、真实清理异常只告警且退出码 0、dry-run 预览异常只告警、`--check --clean-cache` 只读不删缓存。 |
| `scripts/npm/README.md` | 修改 | 选项表新增 `--clean-cache`；「缓存与离线」补充语义（仅 sha256 命名文件、`--zip` 保留本地包对应缓存、仅在至少一个目标安装成功后清理、只读模式不清理、失败只告警、不要并发运行清理）。 |

## 为什么改

变更记录 `2026-10-26-5-npm-installer-cdn-distribution.md` 的风险项明确写了：**每个插件版本在缓存中约占 49 MB，不会自动清理**。`plugin-cache` 会随版本升级持续增长，需要在安装器里提供一个显式、可控的清理入口，同时保证只读模式（`--check` / `--dry-run`）不产生任何删除副作用。

## 行为变化

- 不传 `--clean-cache`：与之前完全一致，不做任何清理。
- 传 `--clean-cache` 且至少一个目标安装成功：安装汇总、启动 IDE 之后删除旧版本缓存 zip 与残留 `.part`，保留本次使用的版本（远端 manifest 的 sha256；`--zip` 时为本地包自身的 sha256，同内容缓存不会被误删）。只处理 sha256 命名的文件，`backup.zip` 等其它文件不动。删除失败只告警，不改变退出码；缓存目录读取失败等清理异常也只告警。
- 传 `--clean-cache` 但所有目标都安装失败：打印「安装失败，已跳过缓存清理」，保留旧缓存以便回滚/重试，退出码仍为 1。
- `--check`：不清理，也不打印清理提示。
- `--dry-run --clean-cache`：扫描缓存但只打印一行预览，例如
  `dry-run：安装后将清理 2 个旧缓存（释放约 98.0 MB），保留本次使用的版本。`，不删除任何文件；预览已前移到 pending 判断之前，全部目标已是最新时也会打印；预览扫描失败只告警并跳过预览。
- 缓存目录不存在、目录内没有 zip/`.part`：返回空结果，不报错。

## 验证

- `cd scripts/npm && npm test`：84 个用例全部通过（缓存清理单测 5 + CLI 端到端 4 + 原有 75），0 失败。
- `node scripts/check-change-log.mjs`：通过。
- `ZCODE_DATA_BASE_DIR=$(mktemp -d) node bin/zcode-idea.mjs --help`：帮助中包含 `--clean-cache` 与「安装结束后清理其它版本的插件包缓存（保留本次使用的版本）」。
- 临时目录 CLI 冒烟：`--dry-run --clean-cache` 只打印预览且文件仍在；真实安装后旧缓存 zip/`.part` 被清理、未知文件保留；`--check --clean-cache` 不打印清理信息也不删除。
- 新增的端到端用例覆盖：全部目标安装失败时跳过清理且退出码 1、缓存目录读取失败（`plugin-cache` 为文件）时只告警且安装仍以 0 结束、dry-run 预览同样只告警、`--check --clean-cache` 退出码 0 且缓存仍在。

## 风险 / 后续

- `--clean-cache` 是显式选项，默认仍不会自动回收缓存；需要长期自动回收时可后续考虑“保留最近 N 个版本”或按时间淘汰。
- 只识别 64 位十六进制 sha256 命名的文件，手工改名/放入的旧缓存不会被清理（这是为不误删用户文件的取舍）。
- 不要与其他 `zcode-idea` 安装进程并发运行 `--clean-cache`：可能删掉对方正在写入的 `.part` 或待解压的 zip，README 已写明。
- 判定条件是“至少一个目标安装成功”：多目标部分失败时仍会清理旧缓存（保留本次版本），失败目标的回滚依赖本次缓存而非旧版本。
- 单个文件删除失败（`failed`）分支未做真实故障注入（Windows 只读文件/权限不足场景）；缓存目录读取失败已用端到端用例覆盖，两者都只告警、不改变退出码。

## 相关

- [npm 安装器改为七牛 CDN 分发](./2026-10-26-5-npm-installer-cdn-distribution.md)
- 文档：`scripts/npm/README.md`「缓存与离线」
