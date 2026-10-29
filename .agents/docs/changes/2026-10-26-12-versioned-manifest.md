# 2026-10-26 · 安装器改读版本化清单（解决稳定 manifest 的 CDN 缓存）

- **范围**：`scripts/npm/lib/remote.mjs`、`scripts/npm/bin/zcode-idea.mjs`、
  `scripts/release.mjs`、npm 测试、README/构建文档
- **触发**：稳定指针 `<channel>/manifest.json` 是可变的，测试域名的 CDN 缓存无法及时刷新
  （实测固定一年、刷新 404），新安装器可能读到旧清单；改为按 npm 包版本读取版本化清单
- **提交**：working tree（未提交；npm 包已发布 `0.0.3`，七牛已上传 `0.0.3` 完整包与版本化清单）
- **版本现状**：仓库根 `package.json` 与 `scripts/npm/package.json` 均为 `0.0.3`

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/lib/remote.mjs` | 修改 | 新增 `validateManifestVersion` / `manifestUrlFor`；`fetchManifestBundle` 必填 `version`，地址改为 `<base>/<version>/manifest.json|.sig`；版本仅允许 semver，非法抛 `UsageError` |
| `scripts/npm/bin/zcode-idea.mjs` | 修改 | 用 npm 包自身 `version` 作为插件版本；按该版本拉清单；校验 `manifest.pluginVersion === pkg.version`，不一致直接 `InstallError`；日志输出“npm 包/插件版本 = X；清单 = URL” |
| `scripts/release.mjs` | 修改 | 硬校验仓库根与 npm 包 version 完全一致；上传 5 个对象：zip → 版本化 manifest.sig/json → 稳定 manifest.sig/json；版本化清单 HEAD 致命、稳定指针仅警告；汇总主清单改为版本化地址 |
| `scripts/npm/test/helpers/plugin-fixture.mjs` | 修改 | 默认 `archivePath` 改为内容寻址 `<channel>/<version>/zcode-ide-<version>-<sha12>.zip` |
| `scripts/npm/test/remote.test.mjs` | 修改 | 清单路由改为 `<base>/<version>/...`；新增版本地址与非法版本用例 |
| `scripts/npm/test/cli-install.test.mjs` | 修改 | 用当前 npm 版本构造 fixture；断言版本化清单请求；新增“清单版本与 npm 版本不匹配报错”用例；降级测试改用 `bumpPatch(npmVersion)` |
| `scripts/npm/test/cli.test.mjs` | 修改 | `--version` 断言改为动态读取 npm 包版本 |
| `scripts/npm/test/helpers/serve-plugin-release.mjs` | 修改 | 注释说明版本化清单路径 |
| `scripts/npm/README.md` | 修改 | 清单地址规则、npm/插件版本必须一致、版本化清单与稳定指针、5 对象上传顺序 |
| `.agents/docs/build/BUILD-AND-DEPLOY.md` | 修改 | 同上 |
| `.agents/docs/changes/2026-10-26-9-plugin-version-source.md` | 修改 | 顶部加注：本文“npm 版本独立”的模型已被本文（12）取代 |
| `.agents/docs/changes/README.md` | 修改 | 索引新增本行 |

## 为什么改

- **稳定指针不可靠**：`<prefix>/plugin/<channel>/manifest.json` 内容随版本变化，但测试域名
  的 CDN 缓存无法刷新（固定长 TTL、刷新 404）。只要安装器读稳定指针，就可能拿到旧清单。
- **版本化清单**：安装器按 **npm 包自身版本** 读取
  `<source>/<npm-version>/manifest.json`。`npx zcode-idea@0.0.3` 只会读
  `.../0.0.3/manifest.json`，不会命中 stable 的旧缓存。版本化路径随 npm 版本天然不可变
  （同版本重发仍会覆盖，但 npm 同版本不可发布，正常发布流程会推进版本）。
- **版本必须同源**：npm 包版本就是插件版本。发布脚本硬校验仓库根与
  `scripts/npm/package.json` 的 version 一致，避免“npm 还是旧版、插件已升版”或反之。
- **兼容旧安装器**：仍上传稳定指针，0.0.1/0.0.2 安装器继续可用；版本化清单是主清单，
  稳定指针只作兼容。
- **缓存分层**：zip 内容寻址（immutable）、版本化清单 new key、稳定指针 no-cache；
  HEAD 对账 zip 与版本化清单失败即致命，稳定指针滞后只警告；CDN 刷新只刷新稳定指针。

## 行为变化

- 安装器远端清单地址：`<source>/<npm 包版本>/manifest.json`（sig 同目录）。
  日志会明确打印“npm 包/插件版本 = X；清单 = URL”。
- 若 `<version>/manifest.json` 里的 `pluginVersion` 与 npm 包版本不一致，安装器直接失败并
  提示两处版本不匹配。
- `--source` 仍只传 base URL（安装器追加版本目录）；`--zip` 模式完全不变。
- 发布脚本在 dry-run/build-only 阶段也做 root/npm 版本一致性硬校验；
  两处版本不同会直接失败（本次已统一为 `0.0.3`）。
- 发布对象从 3 个变为 5 个，顺序：
  `zip → <version>/manifest.sig → <version>/manifest.json → stable manifest.sig → stable manifest.json`。
- 汇总主 manifest URL 为版本化地址，稳定指针标注“兼容旧版”。

## 验证

本机 Node v22.23.4；最终版本 root `0.0.3` / npm `0.0.3`。

| 命令 | 结果 |
|---|---|
| `cd scripts/npm && npm test` | **86 个用例全绿**（含版本化 URL、非法版本、清单版本不匹配、版本化请求路径） |
| 版本不一致时 `node scripts/release.mjs` | 预期失败：`版本不一致：仓库根 package.json version=0.0.1，scripts/npm/package.json version=0.0.2……`，退出码 1 |
| 统一到 `0.0.3` 后 `--apply --push --bundle-runtime` | 构建完整包 49,959,166 字节；上传 zip `.../0.0.3/zcode-ide-0.0.3-dd008704b285.zip`、版本化 `.../0.0.3/manifest.{sig,json}`（HEAD 通过）、稳定指针（HEAD 滞后仅警告）；zip/版本化清单 URL 均 200 |
| `npm publish`（`scripts/npm`，0.0.3） | `+ zcode-idea@0.0.3`；`npm view` 最终 `latest = 0.0.3` |
| 全新 cache `npx --yes zcode-idea@0.0.3 --check --all` | 日志显示 `npm 包/插件版本 = 0.0.3；清单 = .../stable/0.0.3/manifest.json`；验签通过，可用版本 0.0.3（47.6MB）；本机已装 0.1.0 → 状态“跳过（远端版本更低）” |
| 全新 cache + 空数据目录 `npx --yes zcode-idea@0.0.3 --target <临时目录> --yes --force --no-launch` | 下载完整包 49.96MB 并安装 5381 个文件 / 177MB；jar 版本 `0.0.3`；`runtime/web/index.html` 存在；提示“安装的是完整包，已内置 runtime” |
| `--zip` 离线安装回归 | 校验通过并安装 5381 个文件，不访问远端 |
| `node scripts/check-change-log.mjs` | 通过 |

**未验证**：旧版 0.0.1/0.0.2 安装器读取稳定指针的回归（逻辑未改动，仍保留稳定指针，受 CDN 缓存影响）。

## 风险 / 后续

- **当前 0.0.3 低于已装的 0.1.0**：真实 IDE 上会被判为降级（需 `--force`）。
  若要让现有 0.1.0 用户正常升级，下一版应把根与 npm 版本一起提到 `0.1.0` 以上。
- **每次插件更新都必须提升 npm 包版本**：安装器只按自己的版本读清单；不改版本就发新版会读到旧清单。
- **仓库根与 npm 包版本必须同步**：发布脚本会硬失败；发版流程应先改两处再执行。
- 版本化清单在同一版本重发时仍会覆盖；正常流程通过提升 npm 版本避免。
- 稳定指针仍受 CDN 缓存影响，旧安装器可能延迟看到新版本；新安装器不受影响。
- 生产 CDN 建议对稳定指针设 `TTL=0` 或发布后刷新；版本化路径与内容寻址 zip 无需刷新。
- 旧安装器（0.0.1/0.0.2）无法识别版本化清单目录，只能继续读稳定指针；待其被淘汰后可移除稳定指针。

## 相关

- [发布脚本合并与内容寻址](./2026-10-26-6-release-script-merge.md)
- [七牛 CDN 缓存：内容寻址与缓存头](./2026-10-26-10-qiniu-cdn-cache.md)
- [插件版本改为跟随仓库根 package.json（已被本文取代）](./2026-10-26-9-plugin-version-source.md)
- [`../../npm/README.md`](../../npm/README.md)
