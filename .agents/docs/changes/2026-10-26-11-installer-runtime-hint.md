# 2026-10-26 · 安装器 runtime 提示按实际包类型输出（npm 0.0.2）

- **范围**：`scripts/npm/bin/zcode-idea.mjs`、`scripts/npm/package.json`
- **触发**：用户指出安装完成后的提示
  “首次打开面板会自动下载 runtime（薄包）或直接使用内置 runtime（完整包）”
  把两种情况混在一起，无法判断本次装的是哪种；且 `--no-launch` 时不打印
- **提交**：working tree（未提交；npm 包已发布 0.0.2）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/bin/zcode-idea.mjs` | 修改 | 用 `validatePluginZip` 返回的 `hasRuntime` 判断：完整包提示“已内置 runtime，无需额外下载”；薄包提示“首次打开 ZCode 工具窗口时会按需下载 runtime”。提示移到启动分支之前，`--no-launch` 也会打印 |
| `scripts/npm/package.json` | 修改 | npm 包独立版本 `0.0.1` → `0.0.2`（不跟随插件版本），已发布到官方 registry |

## 验证

| 命令 | 结果 |
|---|---|
| `node bin/zcode-idea.mjs --zip build/distributions/zcode-ide-0.0.1.zip --target <temp> --yes --no-launch` | 完整包：`安装完成 …（5381 个文件，177 MB）` + `提示：安装的是完整包，已内置 runtime，打开面板无需额外下载。` |
| `node bin/zcode-idea.mjs --zip <thin-0.0.1.zip> --target <temp> --yes --no-launch` | 薄包：`安装完成 …（6 个文件，4.0 MB）` + `提示：安装的是薄包，首次打开 ZCode 工具窗口时会按需下载 runtime，请保持网络可用。` |
| `cd scripts/npm && npm test` | 84 项全绿 |
| `npm publish --registry https://registry.npmjs.org/` | `+ zcode-idea@0.0.2`；registry 传播需要约 1–2 分钟 |

## 风险 / 后续

- 线上 `npx zcode-idea` 要等 0.0.2 传播完成后才会看到新提示。
- 本次只改提示，不改变下载/安装逻辑。
- 插件 0.0.1 的 manifest 仍受七牛边缘旧缓存影响（stable 仍返回 0.1.0），
  与本次提示修复无关；需要在 CDN 后台刷新 manifest/sig。

## 相关

- [七牛 CDN 缓存：内容寻址 + 缓存头修正与告警](./2026-10-26-10-qiniu-cdn-cache.md)
- [npm 包改发官方 registry](./2026-10-26-8-npm-public-registry.md)
