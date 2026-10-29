# 2026-10-26 · npm 包改发官方 registry（`zcode-idea@0.0.1` 已上线）

- **范围**：`scripts/npm/package.json`、`scripts/release.mjs`、`scripts/npm/README.md`、文档
- **触发**：用户要求把 npm 包从内网 Nexus 改为发布到官方 npm，使用 `ezllm` 项目已有的发布 token
- **提交**：working tree（未提交；npm 包已真实发布）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/package.json` | 修改 | `publishConfig.registry` 改为 `https://registry.npmjs.org/` |
| `scripts/release.mjs` | 修改 | `DEFAULT_REGISTRY` 改为官方 npm；`--registry` 仍可覆盖 |
| `scripts/npm/README.md` | 修改 | “内网/离线”改为“网络/离线”：官方 npm 默认可用；内网镜像与本地 tarball 作为逃生口 |

## 发布结果

- 包名：`zcode-idea`（官方 registry 上此前不存在，npm 属于 `doyzheng`）
- 版本：`0.0.1`
- 体积：36.5 kB（16 个文件，不含插件 zip）
- 发布命令：`cd scripts/npm && npm publish --registry https://registry.npmjs.org/`
- 结果：`+ zcode-idea@0.0.1`，dist-tag `latest` 已指向 0.0.1

## 发布过程中的现象

首次 `npm publish` 后立即查询返回 404，registry packument 只显示
`0.0.0-stage` 占位版本（npm 新版 staged publishing 的临时占位，属正常现象）。
约 2 分钟后 0.0.1 出现在 versions 中，`latest` 切换为 0.0.1；
期间再次执行 `npm stage publish` 会报 `409 Cannot stage previously published version "0.0.1"`，
说明版本已进入发布流程，无需人工 approve。

## 验证

| 命令 | 结果 |
|---|---|
| `npm whoami --registry https://registry.npmjs.org/` | `doyzheng` |
| `npm publish`（`scripts/npm`） | 成功，`+ zcode-idea@0.0.1` |
| `npm view zcode-idea version --registry https://registry.npmjs.org/ --prefer-online` | `0.0.1` |
| 全新 cache `npx --yes zcode-idea --version` | 正常启动本地安装器 |
| 全新 cache `npx --yes zcode-idea --check --all` | 拉取七牛 manifest、验签、版本对比（已安装 0.1.0 / 可用 0.1.0），未下载未安装 |

## 风险 / 后续

- **公网包默认源仍是七牛 HTTP 测试域名**（`http://tnbe4cmeo.hn-bkt.clouddn.com`）。
  该域名可正常下载，但属于测试域名、可能过期；正式对外前应换成自有 HTTPS 域名，
  并同步改 `scripts/npm/lib/remote.mjs` 的 `DEFAULT_PLUGIN_BASE_URL`。
- npm 官方上的 `zcode-idea` 已可被任何人搜索/安装；插件 zip 仍从上述 CDN 获取。
- 后续发新版必须手动提升 `scripts/npm/package.json` 的 `version`（npm 同版本不可覆盖），
  `release:npm` 会先检查远端版本并给出提示。
- 内网无法访问官方 npm 时，可用镜像或本地 tarball（README 已写）。

## 相关

- [发布脚本合并为 `scripts/release.mjs`](./2026-10-26-6-release-script-merge.md)
- [npm 安装器改为七牛 CDN 分发](./2026-10-26-5-npm-installer-cdn-distribution.md)
- [`../../npm/README.md`](../../npm/README.md)
