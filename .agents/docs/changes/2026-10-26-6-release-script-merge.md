# 2026-10-26 · 发布脚本合并为 `scripts/release.mjs`（版本单一来源 + 内容寻址）

- **范围**：`scripts/release.mjs`（新增）、删除三个旧发布脚本、仓库根 `package.json` scripts、
  npm 本地更新 helper、npm README 与构建文档
- **触发**：用户要求把 `package-plugin-release.mjs`、`publish-plugin-release.mjs`、
  `publish-npm.mjs` 合并为一个脚本，版本只认 `scripts/npm/package.json`；
  真实上传测试又暴露了“同版本覆盖 + 边缘缓存”导致的清单/包错配，本次一并修正
- **提交**：working tree（未提交；七牛真实上传已在临时前缀 `zcode-ide-test` 验证）
- **后续**：npm 发布目标后来改为官方 registry，`zcode-idea@0.0.1` 已上线，
  见 [npm 包改发官方 registry](./2026-10-26-8-npm-public-registry.md)

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/release.mjs` | 新增 | 一条命令完成：版本检查 → 构建/复用 zip → 校验 jar 版本 → manifest + Ed25519 签名 → 七牛上传 → npm 发布；默认 dry-run；新增 `--build-only`；zip 改为内容寻址；HEAD 对账带重试与分级 |
| `scripts/package-plugin-release.mjs` | 删除 | 能力并入 `release.mjs` |
| `scripts/publish-plugin-release.mjs` | 删除 | 七牛上传实现并入 `release.mjs` |
| `scripts/publish-npm.mjs` | 删除 | npm 发布并入 `release.mjs --npm` |
| `scripts/local-install.mjs` | 新增 | 本地 `npm pack` + `npx --yes --package <tarball> -- zcode-idea ...` 强制更新；透传参数；不在 npm 包的 `files` 内 |
| `package.json`（仓库根） | 修改 | 新增 `release` / `release:push` / `release:npm` / `plugin:build` / `plugin:pack` / `plugin:local-update`；不动 version 与 devDependencies |
| `scripts/npm/README.md` | 修改 | 常用命令、发布链路、对象布局、内容寻址与 HEAD 重试说明 |
| `.agents/docs/build/BUILD-AND-DEPLOY.md` | 修改 | “插件 + npm 发布（本地人工）”增加 `--build-only`、内容寻址与 HEAD 分级 |
| `.agents/docs/build/RUNTIME-DISTRIBUTION.md` | 修改 | §11.1 第 7 步指向 `release.mjs` |
| `.agents/docs/changes/2026-10-26-3/5-*.md` | 修改 | 顶部加注：旧发布脚本已合并，旧命令仅作历史记录 |
| `.agents/docs/changes/README.md` | 修改 | 索引新增/更新本行 |

## 为什么改

- **三个脚本重复了密钥加载、版本解析、七牛上传、npm 调用**，版本来源容易漂移。
  合并后只有一个版本源 `scripts/npm/package.json`，同一版本同时用于插件、OSS 路径、
  manifest 与 npm。
- **npm 同版本不可覆盖**：发布前用 `npm view <name>@<version>` 预检，已存在则要求先手动改 version。
- **真实上传暴露的边缘缓存问题**：同版本 zip 覆盖同一个 key 时，七牛测试域名边缘仍返回
  旧的 51MB zip（`Cache-Control: public, max-age=31536000`），而新 zip 只有 3.8MB；
  脚本在 manifest 已上传后 HEAD 对账失败，存在“清单指向新 zip、边缘仍在发旧 zip”的窗口。
  测试域名不支持 CDN 刷新（404），无法靠 purge 收敛。
- **修正方式：zip 内容寻址**：
  `<prefix>/plugin/<channel>/<version>/zcode-ide-<version>-<sha12>.zip`。
  同版本重发会得到新 key，旧 zip 保留；manifest/sig 是唯一可变指针。
  即使边缘 manifest 短暂滞后，也只会指向旧 zip，不会出现清单/包错配。
- **HEAD 对账分级**：每对象首次 + 重试 3 次（1s/2s/4s）。zip 是新 key，失败仍致命；
  manifest/sig 可变，重试后仍不一致只警告，因为 zip 已成功且清单指向不可变对象。
  另外把 zip 的 HEAD 对账提前到 manifest 上传之前：zip 未就绪就不会更新清单。
- **两级开关**：`--apply` 只执行本地步骤（构建/复用 zip、写 manifest + sig），
  真正的远端写入需要 `--apply --push`；npm 发布需要 `--apply --push --npm`。
  便于联调/CI，也避免误上传。
- **build-only 与本地更新**：提供只构建 zip 的 `--build-only`，以及
  `npm run plugin:local-update` 一条命令完成本地打包 + 强制更新。

## 行为变化

- 默认 `node scripts/release.mjs`：只读版本/环境并打印命令、对象 key/URL、manifest 预览；
  不构建、不写文件、不上传、不发 npm。
- `--build-only`：读版本 → `build-runtime`（可用 `--skip-runtime` 跳过）→
  `gradlew buildPlugin -PpluginVersion=<v>` → 校验 jar 的 id/version 后退出；
  不生成 manifest、不上传、不发 npm；需要 JDK 21；版本低于 gradle 只警告不拒绝。
- `--apply`：构建（或 `--skip-build` 复用）、jar 版本校验、manifest + 签名；不写远端。
- `--apply --push`：上传 zip（内容寻址）→ HEAD 对账（致命）→ manifest.sig → manifest.json
  → 可变指针 HEAD 对账（仅警告）→ 刷新 manifest/sig 的 CDN。
- `--apply --push --npm`：额外检查 npm 远端版本并 `npm publish`。
- 对象布局：
  - `<prefix>/plugin/<channel>/<version>/zcode-ide-<version>-<sha12>.zip`（immutable）；
  - `<prefix>/plugin/<channel>/manifest.json|.sig`（no-cache，可变指针）。
  `archivePath` 仍含 `<prefix>`，安装器从域名根解析。
- 版本规则：package 版本低于 gradle 默认拒绝（`--allow-downgrade` 仅联调）；
  `--skip-build` 时 zip 与 package 版本不一致会明确报错。
- 仓库根新增 6 个 npm scripts；`plugin:local-update` 默认 `--all --yes --force`，
  可用透传参数覆盖（如 `--target`、`--no-launch`）。

## 验证

本机 Node v22.23.4；系统 `java` 为 1.8，真实构建时显式使用
`JAVA_HOME=C:\Users\<user>\.jdks\jdk-21.0.12.1+1`。

| 命令 | 结果 |
|---|---|
| `node scripts/release.mjs --help` | 打印完整中文用法、对象布局（内容寻址）、版本规则 |
| `npm test`（`scripts/npm`） | 84 个用例全绿（含内容寻址 URL 解析与缓存清理用例） |
| `npm run release` | dry-run：版本 `zcode-idea@0.0.1`、gradle `0.1.0`，打印降级拒绝提示、JDK 1.8 警告；key 为 `zcode-ide/plugin/stable/0.0.1/zcode-ide-0.0.1-<sha12>.zip`（未构建时占位） |
| `npm run plugin:build`（无 JDK 21） | 退出码 1，明确报“需要 JDK 21，当前：openjdk version "1.8.0_502"” |
| `JAVA_HOME=<JDK21> npm run plugin:build` | 成功：`build-runtime` + `gradlew buildPlugin -PpluginVersion=0.0.1`（Gradle 6s），产物 `zcode-ide-0.0.1.zip` 3,827,521 字节（薄包），jar 版本 0.0.1 |
| `node scripts/release.mjs --apply --skip-build --allow-downgrade` | manifest 的 `archivePath=zcode-ide/plugin/stable/0.0.1/zcode-ide-0.0.1-b3bb4620163c.zip`，sha256/size 与原 zip 一致；仓库公钥独立验签返回 `true`；未上传 |
| 临时把 `scripts/npm/package.json` 改为 `0.1.0` 后 `--apply --skip-build` | `archivePath=zcode-ide/plugin/stable/0.1.0/zcode-ide-0.1.0-b3bb4620163c.zip`，版本目录与 zip 版本一致；独立验签 `true`；随后恢复 `0.0.1`（`git diff` 无残留） |
| `npm run plugin:pack` | 生成 `zcode-idea-0.0.1.tgz`（约 36 kB，16 个文件，无 zip） |
| `npm run plugin:local-update -- --target "<含空格临时目录>/plugins" --no-launch` | `npm pack` 到独立临时目录 → `npx --yes --package <tarball> -- zcode-idea --all --yes --force ...`；复用缓存安装 5381 个文件到临时目录，未触碰真实 IDE |
| 同上，另加 `ZCODE_DATA_BASE_DIR=<临时目录>`（空缓存） | 真实从七牛测试域名下载 49.1 MB（约 12 MB/s）、校验并安装 5381 个文件 / 191 MB 到临时目录 |
| 真实上传（临时版本 0.1.0，`--apply --push --skip-build --prefix zcode-ide-test --channel test --allow-http`） | zip 51,490,265 B 上传 15.6s，key `zcode-ide-test/plugin/test/0.1.0/zcode-ide-0.1.0-b3bb4620163c.zip`（immutable）；zip HEAD 对账通过；manifest.sig / manifest.json 上传后 HEAD 对账通过；CDN 刷新 404 仅警告；退出码 0 |
| 测试源回读 | `npx ./zcode-idea-0.0.1.tgz --check --source .../zcode-ide-test/plugin/test --allow-http` 成功验签并完成版本对比（已安装 0.1.0 / 可用 0.1.0） |
| `node scripts/check-change-log.mjs` | 通过 |

**同版本覆盖的修正过程**：首次用旧设计覆盖 stable 同 key 时，边缘仍返回旧的 51MB zip
（`Cache-Control: public, max-age=31536000`），新 zip 只有 3.8MB，manifest 已上传但 HEAD
对账失败；测试域名刷新接口 404，无法 purge。已把 stable 源站恢复为旧的 51MB zip +
旧 manifest/sig（独立验签 `true`，安装器 `--check` 正常），随后改为内容寻址并在全新前缀
`zcode-ide-test` 完成上述真实上传验证。

**未验证**：真实 `npm publish`（按要求未执行）；macOS/Linux 真机；有 IDE 运行时的关闭流程。

## 风险 / 后续

- **manifest/sig 边缘滞后**：内容寻址消除了 zip 错配，但清单本身仍是可变对象；
  生产 CDN 必须支持刷新，否则新版本可能延迟可见（测试域名刷新 404 属已知情况）。
- **zip HEAD 失败仍会退出**：此时 zip 已上传但 manifest 尚未上传（zip 校验在清单之前），
  不会产生“清单指向坏包”的状态；重跑即可复用同内容 key。
- **旧 zip 会累积**：同版本多次重建会产生多个内容寻址对象，需要在七牛侧配生命周期清理。
- **`--allow-downgrade` 可制造“manifest 版本 ≠ jar 版本”的产物**，仅用于联调。
- **`plugin:local-update` 依赖网络**：默认从七牛测试域名下载 zip（可复用缓存）。
  helper 把 `npm pack` 输出改到 `os.tmpdir()` 的独立目录：Windows 上重复执行时，
  上一轮的 `zcode-idea-0.0.1.tgz` 可能仍被 npx 或杀软占用，直接在包目录 pack 会
  `EBUSY`（本次实测踩到并修正）。另外 npm 10 下直接 `npx <tarball> --all ...` 会把
  后续参数当成 npm 选项而静默退出，因此统一用
  `npx --yes --package <tarball> -- zcode-idea ...`。
- **构建需要显式 JDK 21**：本机 `java` 默认 1.8，`plugin:build` 会明确报错；
  已用 `JAVA_HOME` 指向 JDK 21 验证成功路径。
- npm 发布与 OSS 上传串行：OSS 成功、npm 失败时需人工重跑 npm。

## 相关

- [npm 安装器改为七牛 CDN 分发](./2026-10-26-5-npm-installer-cdn-distribution.md)
- [npm 安装器初版](./2026-10-26-3-npm-installer.md)
- [`../../npm/README.md`](../../npm/README.md)
- [`../build/BUILD-AND-DEPLOY.md`](../build/BUILD-AND-DEPLOY.md)
