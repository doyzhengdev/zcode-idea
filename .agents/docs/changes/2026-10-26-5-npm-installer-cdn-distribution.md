# 2026-10-26 · npm 安装器改为七牛 CDN 分发（包体 49MB → 约 33KB）

- **范围**：`scripts/npm/`、`scripts/package-plugin-release.mjs`（新增）、
  `scripts/publish-plugin-release.mjs`（新增）、`scripts/publish-npm.mjs`、文档
- **触发**：需求变更——Nexus 上传 49MB 插件包实测超时（内网约 137KB/s），
  npm 包必须只保留代码；插件 zip 与 manifest 改由七牛 CDN 分发
- **提交**：working tree（未提交；按要求**未执行 `npm publish`**，改用本地 tarball；七牛已真实上传并完成本机 IDE 安装验证）

> **后续变更（2026-10-26）**：本文新增的三个发布脚本
> `package-plugin-release.mjs` / `publish-plugin-release.mjs` / `publish-npm.mjs`
> 已合并为 `scripts/release.mjs`，见
> [release 脚本合并](./2026-10-26-6-release-script-merge.md)；下文的旧命令仅作历史记录。

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/package.json` | 修改 | `files` 去掉 `dist`；删除 `prepack`；版本仍为 `0.0.1` |
| `scripts/npm/dist/`、`scripts/npm/scripts/copy-dist.mjs` | 删除 | 不再把 zip/manifest 打进 npm 包 |
| `scripts/npm/lib/plugin-signing-public.pem` | 新增 | 仓库 Ed25519 公钥副本，运行期验签信任根 |
| `scripts/npm/lib/remote.mjs` | 新增 | 源解析（默认七牛测试域名/`--source`/env）、拉取 manifest+sig、Ed25519 验签、manifest 与 archivePath 校验、版本比较、3 次退避重试 |
| `scripts/npm/lib/download.mjs` | 新增 | `~/.zcode/ide/plugin-cache/<sha256>.zip` 缓存、`.part` 原子改名、sha256/size 校验、TTY/非 TTY 进度、3 次重试 |
| `scripts/npm/lib/installed.mjs` | 新增 | 从已安装 jar 的 `META-INF/plugin.xml` 读取 `<version>` |
| `scripts/npm/lib/manifest.mjs` | 重构 | 删除本地 dist manifest 校验；新增 `validatePluginZip`（sha/size/version 对账、条目安全、重复条目、jar id/version、runtime 完整性） |
| `scripts/npm/bin/zcode-idea.mjs` | 重写 | 新增 `--check` / `--force` / `--source` / `--zip` / `--allow-http`；版本对比、跳过策略、缓存提示、新的步骤输出；补回 node shebang（否则 Windows npm shim 无法调用） |
| `scripts/npm/test/*.test.mjs`、`test/helpers/*` | 修改/新增 | 74 个用例；新增本地随机端口 HTTP 集成、验签、缓存、重试、CLI 端到端（需要仓库私钥，缺失时跳过） |
| `scripts/npm/README.md` | 重写 | 远端源、版本语义、缓存、离线、安全模型、发布链路、内网注意事项 |
| `scripts/npm/.gitignore` | 修改 | 移除已不存在的 dist 规则 |
| `scripts/package-plugin-release.mjs` | 新增 | 取最新插件 zip，生成 `build/plugin-release/{zip, manifest.json, manifest.sig}`；签名私钥取 `RUNTIME_SIGNING_KEY` 或 `~/.zcode/keys/runtime-signing-private.pem`；自检公钥一致性 |
| `scripts/publish-plugin-release.mjs` | 新增 | 七牛上传（复制 publish-runtime 的最小实现），默认 dry-run、`--apply` 上传；顺序 zip → sig → manifest；打印完整 URL；版本路径不可变对账 |
| `scripts/publish-npm.mjs` | 修改 | 去掉 prepack，只发布 npm 小包 |
| `.agents/docs/changes/README.md` | 修改 | 索引新增一行 |

## 为什么改

- **npm 包不能携带 49MB zip**：内网 Nexus 约 137KB/s，上传 49MB 会超时；
  安装器代码只有约 31KB，适合走 npm，插件包适合走 CDN。
- **安全边界要前移到发布物**：npm 包内只保留公钥；远端 manifest 用 Ed25519 签名，
  客户端验签通过后才采信 sha256/size/version；zip 再按这些值校验，形成
  “公钥 → manifest → zip” 的信任链。
- **版本不可变**：zip 对象键包含版本号，发布脚本对同 key 做 HEAD + sha256 对账，
  内容不同直接失败，避免客户端缓存/回滚时拿到被覆盖的产物。
- **默认可用**：当前唯一可用的七牛测试域名是 HTTP，因此把它 bake 成默认源并
  每次打印警告；显式指定其他 HTTP 源仍需 `--allow-http`，生产应使用 HTTPS。
- **`archivePath` 语义**：按补充要求，manifest 里写相对 CDN 根的完整对象键
  （`<prefix>/plugin/<channel>/<zip>`），与 runtime manifest 的模型一致；
  安装器对含 prefix 的路径从域名根解析，只有文件名时退回“相对 manifest 目录”，
  两种都经过绝对 URL / `..` / 反斜杠校验。

## 行为变化

- `npx zcode-idea` 默认从
  `http://tnbe4cmeo.hn-bkt.clouddn.com/zcode-ide/plugin/stable` 拉取 manifest；
  启动时打印测试域名警告。不再读取包内 `dist/`。
- 新增 `--check`（只对比版本）、`--force`（重装/降级）、`--source`、`--zip`、`--allow-http`。
- 已安装版本与远端版本比较：远端更高→更新；相同→“已是最新”跳过；远端更低→拒绝降级。
- 插件包缓存到 `${ZCODE_DATA_BASE_DIR:-~/.zcode}/ide/plugin-cache/<sha256>.zip`；
  命中则复用，`--force` 也不重复下载。
- `--dry-run` 只拉 manifest、对比版本、打印计划与缓存状态，不下载。
- npm tarball 从 47.34MB 降到 32,983 字节（约 32 KB，16 个文件，含公钥，不含 zip/dist）。

## 验证

| 命令 | 结果 |
|---|---|
| `cd scripts/npm && npm test` | 74 个用例全绿（验签成功/失败、archivePath 越界、版本比较、缓存命中与 sha 不符、下载重试、`--zip`、`--check` 不下载、真实 HTTP 集成、CLI 端到端、bin shebang） |
| `node scripts/package-plugin-release.mjs` | 生成 manifest（`archivePath=zcode-ide/plugin/stable/zcode-ide-0.1.0.zip`、sha256 `b3bb4620…`、size `51490265`）与 64 字节 Ed25519 签名（base64 88 字符）；自检公钥验签通过 |
| `node scripts/publish-plugin-release.mjs --allow-http`（带 `QINIU_DOMAIN=http://tnbe4cmeo.hn-bkt.clouddn.com`、`QINIU_BUCKET=<your-bucket>`、`QINIU_PREFIX=zcode-ide`） | dry-run 打印三个完整 URL：`…/zcode-ide/plugin/stable/{zip,manifest.sig,manifest.json}`，未发网络请求 |
| 同上加 `--apply` | 真实上传成功：zip 51,490,265 B 用时 9.3s，`manifest.sig` / `manifest.json` 各 0.1s；三个对象 `HEAD`/`GET` 均 200，`Content-Length` 与清单一致；CDN 刷新接口在测试域名返回 404（仅刷新失败，不影响对象读取） |
| `npx --yes ./zcode-idea-0.0.1.tgz --check --all` | 拉取七牛 manifest 并验签；版本对比 `已安装 0.1.0 / 可用 0.1.0 → 已是最新`；未下载、未安装 |
| `npx --yes ./zcode-idea-0.0.1.tgz --all --yes --force` | 真实安装到本机 `IntelliJIdea2026.2`：下载 49.1MB（约 9.9MB/s）、验签与 sha256/结构校验通过、解压 5381 个文件 / 191MB，并按设计启动 IDEA；退出码 0 |
| 安装后核对 | 安装目录 5381 个文件；`lib/zcode-ide-0.1.0.jar` sha256 与 CDN zip 内同名文件完全一致；`runtime/web/index.html` 存在（完整包） |
| 安装后 IDE 日志 | `Loaded custom plugins: … ZCode IDE (0.1.0)`；`dev.zcode.ide=PluginData(enabled=true…)`；`Starting ZCode server … web=…\plugins\zcode-ide\runtime\web`（确认用的是包内 runtime，而非仓库 dist） |
| 本地 HTTP 服务 + 真实 50MB 发布物：`--source http://127.0.0.1:<port>/zcode-ide/plugin/stable --target <temp> --yes --no-launch --allow-http` | 5.7 秒完成：manifest 验签、下载 49.1MB、sha256/结构校验（5899 条目 / 5381 文件）、解压 191MB；jar 与 `runtime/web/index.html` 存在；缓存文件生成 |
| 同一目标再跑 | `已是最新（跳过）`，无重新下载 |
| `--force` | `强制重装`，复用本地缓存，无重新下载 |
| `--check`（新目标） | 打印版本对比（未安装 → 将安装），目标目录不存在、缓存 mtime 不变 |
| 默认源 `--check --all` | 打印“正在使用七牛测试域名（HTTP）…”警告；从真实七牛 manifest 完成验签与版本对比 |
| `npm pack` | 32,983 字节（约 32 KB），16 个文件，包含 `lib/plugin-signing-public.pem`，无 zip/dist |
| 安装 tarball 到临时目录后 `npx --no-install zcode-idea --version` / `--help` / `--check --source <本地 HTTP>` | 正常输出，`--check` 走完验签与版本对比；发现并修复了 bin 缺少 node shebang 导致 Windows shim 无法调用的问题（已补单测） |
| `node scripts/check-change-log.mjs` | 通过 |

**未验证 / 按需延后**：`npm publish` 按要求未执行（本地 tarball 已验证）；
macOS/Linux 真机；有 IDE 运行时的关闭流程（本机执行时 IDE 未运行）。

## 风险 / 后续

- **默认源是 HTTP 测试域名**：只能用于联调；生产必须用 `--source` 指向 HTTPS 自有域名，
  并考虑后续把默认常量改为生产域名。
- **首次安装依赖网络**：CDN 不可达时只能用 `--zip` 或预热缓存；
  manifest/sig 已设置 `no-cache` 并在发布后刷新 CDN，但边缘缓存仍有短暂延迟。
- **缓存体积**：每个插件版本在 `~/.zcode/ide/plugin-cache` 占约 49MB，不会自动清理。
- **archivePath 含前缀**：客户端从域名根解析；若将来把 manifest 放到镜像子路径，
  需要保证对象键仍可从该源 origin 根解析，或在 manifest 中改用相对 manifest 目录的写法。
- **签名密钥轮换**：npm 包内置公钥必须与发布私钥配套；
  `package-plugin-release.mjs` 已校验仓库/NPM 公钥一致，但发版后轮换密钥需要同时发布新版 npm 包。
- **测试域名不支持 CDN 刷新**：`publish-plugin-release.mjs --apply` 的刷新请求返回 404；
  对象本身已上传且可读。生产域名需确认刷新接口可用，或依赖 `?v=` / 版本化路径规避缓存。
- **测试域名是 HTTP 且可能过期**：生产发布前应换成自有 HTTPS 域名，并把默认源常量一起更新。
- Windows 安装目录目标仍需管理员权限（写探针会过滤并提示）。

## 相关

- [npm 安装器初版（包内携带 zip，已被本次取代）](./2026-10-26-3-npm-installer.md)
- [安装目录写探针与帮助文案修正](./2026-10-26-4-npm-installer-write-probe.md)
- [`../../npm/README.md`](../../npm/README.md)
- `scripts/publish-runtime.mjs`（七牛上传与验签的既有实现）
