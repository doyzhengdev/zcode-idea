# 2026-10-26 · 插件版本改为跟随仓库根 `package.json`

- **范围**：仓库根 `package.json`、`scripts/release.mjs`、npm README、构建文档
- **触发**：用户要求插件版本号跟随仓库根 `package.json` 的 `version`，插件打包时自动读取；
  npm 包版本保持独立，不跟随
- **提交**：working tree（未提交）

> **后续变更（2026-10-26）**：本文“npm 包版本独立”的模型已被
> [安装器改读版本化清单](./2026-10-26-12-versioned-manifest.md) 取代：
> npm 包版本与插件版本必须一致，仓库根与 `scripts/npm/package.json` 的 version 由发布脚本硬校验。

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `package.json`（仓库根） | 修改 | `version` 由 `0.0.0` 改为 `0.0.1`，作为插件版本唯一来源 |
| `scripts/release.mjs` | 修改 | 插件版本改为读取仓库根 `package.json`；npm 包版本独立读取 `scripts/npm/package.json`；移除“插件版本低于 gradle.properties 就拒绝发布”的旧拦截，改为仅提示（构建用 `-PpluginVersion` 覆盖）；`--npm` 的远端版本检查改用 npm 包自身版本 |
| `scripts/npm/README.md` | 修改 | 明确“插件版本来自仓库根 package.json / npm 包版本独立”；安装时读取七牛 manifest 的 `pluginVersion` |
| `.agents/docs/build/BUILD-AND-DEPLOY.md` | 修改 | 同步版本来源说明 |

## 版本语义

- **插件版本**：仓库根 `package.json` → 构建时自动传给
  `gradlew buildPlugin -PpluginVersion=<版本>`；同一版本用于七牛对象路径
  `<version>/zcode-ide-<version>-<sha12>.zip` 与 `manifest.pluginVersion`。
- **npm 包版本**：`scripts/npm/package.json`，独立维护；发 npm 前手动提升
  （官方 npm 同版本不可覆盖）。
- **安装时**：`npx zcode-idea` 只读取七牛 `manifest.json` 的 `pluginVersion`
  作为“最新可用版本”，与本地已装版本对比；npm 包里不内置插件版本号。

## 验证

| 命令 | 结果 |
|---|---|
| `node scripts/release.mjs`（dry-run） | 打印“插件版本源：package.json（仓库根）→ 0.0.1”“npm 包版本（独立）→ zcode-idea@0.0.1”；构建命令为 `-PpluginVersion=0.0.1`；仅提示低于 gradle.properties 的 0.1.0，不拒绝 |
| `JAVA_HOME=<JDK21> npm run plugin:build` | 构建成功，产物 `zcode-ide-0.0.1.zip`；解出主 jar 内 `META-INF/plugin.xml` 为 `<id>dev.zcode.ide</id>`、`<version>0.0.1</version>` |
| `npm run plugin:pack` | 仍使用 npm 包独立版本 `0.0.1`（未因根版本同步逻辑改变） |
| `npx zcode-idea --check --all`（官方 npm） | 打印“已安装 0.1.0 / 可用 0.1.0”，可用版本来自七牛 manifest，证明安装器运行时读取远端最新版本 |
| `node scripts/check-change-log.mjs` | 通过 |

## 风险 / 后续

- 当前根版本 `0.0.1` 低于已发布到七牛的 `0.1.0`；若用该版本发布，安装器会视为降级
  （同版本重发请先确认版本序号策略）。
- `gradle.properties` 的 `pluginVersion` 仍是 `0.1.0`；发布/`plugin:build` 会用
  `-PpluginVersion` 覆盖，但直接运行 `./gradlew buildPlugin` 仍会产出 0.1.0。
  如需本地构建也统一，可后续把 gradle.properties 也纳入版本同步。
- npm 包与插件版本独立后，发布 npm 时必须单独提升 `scripts/npm/package.json`。

## 相关

- [发布脚本合并为 `scripts/release.mjs`](./2026-10-26-6-release-script-merge.md)
- [npm 包改发官方 registry](./2026-10-26-8-npm-public-registry.md)
