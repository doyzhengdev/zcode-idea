# 构建与部署（顺序严格）

> 新机器准备、CI/发版、三类改动各自的构建路径、本机部署。
> 环境路径与调试见 [`ENVIRONMENT.md`](../development/ENVIRONMENT.md)；CI 细节见 [`CI.md`](./CI.md)。
> 薄插件（默认，只打 Kotlin，runtime 从七牛按需下载/更新/回滚）**已实施（2026-10-25）**，设计与落地记录见 [`RUNTIME-DISTRIBUTION.md`](./RUNTIME-DISTRIBUTION.md)；runtime 发布命令在本文件 §2 与该文档 §5.4/§11。

## 1. 新机器 / 版本锁定

```bash
node scripts/bootstrap.mjs          # 按 vendor/zcode.lock 准备 vendor/ZCode 工作副本（缺失时 clone）
node scripts/bootstrap.mjs --check  # CI：只校验，不 clone/切换
```

`build-runtime.mjs` 会校验 fork HEAD 与锁一致（本地只警告，CI 环境或 `ZCODE_STRICT_LOCK=1` 时失败），并把 commit/dirty/插件版本写进 `dist/BUILD-INFO.json`。提交 fork 改动后运行 `node scripts/bootstrap.mjs --update` 更新锁。

## 2. CI / 发布

```bash
node scripts/ci-build.mjs                 # clone/install/build/runtime/buildPlugin + sha256
node scripts/ci-build.mjs --skip-install  # 复用已有 node_modules
```

工作流见 [`.github/workflows/build-plugin.yml`](../../.github/workflows/build-plugin.yml)，Work Go / 自托管 runner 的接法见 [`CI.md`](./CI.md)。插件包必须在 Windows 上构建（原生依赖），发版前先 `--update` 锁。

`ci-build.mjs` 还会跑 `node scripts/patch-budget.mjs`：修改的官方源码文件数不得超过 `vendor/zcode.lock` 的 `patchBudget.maxModified`。预算口径与 rebase 关注点见 [`ZCODE-UPSTREAM-SYNC.md`](../upstream/ZCODE-UPSTREAM-SYNC.md) 的「补丁预算」。

### runtime 打包与发布（CI）

`ci-build.mjs` 在 `build-runtime.mjs` 之后、`buildPlugin` 之前插入 runtime 打包/发布段（薄插件方案见 [`RUNTIME-DISTRIBUTION.md`](./RUNTIME-DISTRIBUTION.md)）：

1. `node scripts/package-runtime.mjs --write-manifest --require-sign`：确定性 zip + manifest + Ed25519 签名，并把 baseline manifest 写入 `src/main/resources/runtime-manifest.json`；
2. 发布开关开启时 `node scripts/publish-runtime.mjs --apply` 上传七牛（顺序 zip → manifest.sig → manifest.json）；
3. 打包、签名、发布配置、上传任一步失败 → 不构建插件、退出码非 0（baseline 指向不存在的对象比发不出包更糟）。

本地开发（非 CI 且未设 `RUNTIME_SIGNING_KEY`）自动跳过该段并打警告，只打薄插件。

Secrets（仓库 Settings → Secrets and variables → Actions）：

| Secret | 必需性 | 说明 |
|---|---|---|
| `RUNTIME_SIGNING_KEY` | 必需 | Ed25519 私钥，PEM 原文或 base64；CI 缺失时打包段失败，属预期闸门 |
| `QINIU_ACCESS_KEY` / `QINIU_SECRET_KEY` / `QINIU_DOMAIN` | 发布时必需 | 七牛密钥与 CDN 域名（必须 `https://`），绝不入库、绝不打印 |
| `QINIU_BUCKET` / `QINIU_PREFIX` / `QINIU_UPLOAD_HOST` | 可选 | 缺省 `zcode-ide` / `zcode-ide` / `https://up-z2.qiniup.com` |

发布开关：手动触发（workflow_dispatch）时勾选 **publishRuntime**（「上传 runtime 到七牛（需要仓库 Secrets）」）；脚本侧等价于 `CI_PUBLISH_RUNTIME=1` 或 `node scripts/ci-build.mjs --publish-runtime`。tag push 一律不发布。workflow 额外上传 `zcode-runtime-package` artifact（`build/runtime/*`，仅当存在时）。

本地人工发布（对应方案 §5.4；`~/.zcode/keys/runtime-signing-private.pem` 是当前本机私钥）：

```bash
export QINIU_ACCESS_KEY=...
export QINIU_SECRET_KEY=...
export QINIU_BUCKET=zcode-ide
export QINIU_DOMAIN=https://cdn.example.com
export QINIU_PREFIX=zcode-ide
export QINIU_UPLOAD_HOST=https://up-z2.qiniup.com
export RUNTIME_SIGNING_KEY="$(cat ~/.zcode/keys/runtime-signing-private.pem)"

node scripts/build-runtime.mjs
node scripts/package-runtime.mjs --write-manifest --require-sign
node scripts/publish-runtime.mjs --apply

./gradlew buildPlugin

# 验证（换成实际 CDN 域名与版本目录）
curl -I "https://cdn.example.com/zcode-ide/runtime/stable/manifest.json"
curl -I "https://cdn.example.com/zcode-ide/runtime/stable/manifest.sig"
curl -I "https://cdn.example.com/zcode-ide/runtime/stable/<version>/zcode-runtime.zip"
```

### 插件 + npm 发布（本地人工）

插件 zip、manifest 签名、七牛上传与 npm 发布已合并为 `scripts/release.mjs`：

```bash
node scripts/release.mjs                       # dry-run：只读版本/环境、打印计划
node scripts/release.mjs --build-only          # 只构建插件 zip，不发布
node scripts/release.mjs --apply               # 构建/复用 zip + 生成 manifest/sig（不上传）
node scripts/release.mjs --apply --push --npm  # 上传七牛 + 发布 npm
```

- **npm 包版本 = 插件版本**：唯一版本源 `scripts/npm/package.json` 的 `version`；
  仓库根 `package.json` 的 `version` 必须与之一致（脚本硬校验，不一致直接失败）；
  构建传 `-PpluginVersion=<version>`，并校验 jar 内 `<id>/<version>`；
- `--apply` 与 `--push` 是两级开关：前者只做本地步骤，后者才写远端；
- **zip 内容寻址**：`<prefix>/plugin/<channel>/<version>/zcode-ide-<version>-<sha12>.zip`，
  同版本重发会写新 key、旧 zip 保留，避免 CDN 边缘旧缓存与清单错配；
- **版本化清单**：安装器读取 `<prefix>/plugin/<channel>/<version>/manifest.json|.sig`，
  不再依赖稳定 `manifest.json`（避免可变清单的 CDN 缓存）；稳定指针仍上传，
  仅用于兼容 0.0.1/0.0.2 旧安装器；
- 上传顺序：zip → 版本化 manifest.sig → 版本化 manifest.json → 稳定 manifest.sig
  → 稳定 manifest.json；
- zip 可长期缓存（immutable）；版本化清单/稳定指针为 no-cache；
  HEAD 对账重试 3 次（1s/2s/4s）：zip 与版本化清单失败致命，稳定指针滞后只警告；
  CDN 刷新只针对稳定指针；
- npm 发布到**官方 registry** `https://registry.npmjs.org/`（`publishConfig` 与
  `release.mjs` 默认值一致），认证沿用 `~/.npmrc` 或 `NODE_AUTH_TOKEN`；
  npm 同版本仍不可覆盖，`--npm` 发布前会检查远端，已存在则提示先手动改 `version`；
- 签名私钥 `RUNTIME_SIGNING_KEY` 或 `~/.zcode/keys/runtime-signing-private.pem`。

## 3. 只改 Kotlin / plugin.xml

```bash
cd /e/work/doyzheng/zcode-ide
JAVA_HOME=/c/Users/<user>/.jdks/jdk-21.0.12.1+1 ./gradlew buildPlugin --console=plain
# 产物：build/distributions/zcode-ide-0.1.0.zip（薄包约 3.8MB，默认不含 runtime/，
#       首次打开面板时按需下载；-PbundleRuntime=true 打约 51MB 完整包，供离线/内网）
```

## 4. 改过 `vendor/ZCode/packages/web-ide`（或任何前端/官方源码）

```bash
cd /e/work/doyzheng/zcode-ide/vendor/ZCode
export PATH="/c/Users/<user>/scoop/persist/nvm/nodejs/v24.14.0:$PATH"
pnpm --filter @zcode/web-ide build          # 其他包按改动范围补 build

cd /e/work/doyzheng/zcode-ide
node scripts/build-runtime.mjs              # 必须重跑，否则 zip 里是旧 bundle
JAVA_HOME=/c/Users/<user>/.jdks/jdk-21.0.12.1+1 ./gradlew buildPlugin --console=plain
```

**顺序不能颠倒**：`buildPlugin` 只打包 `dist/`，不会编译前端。校验 zip 与源码 dist 的 hash 一致：

```bash
unzip -l build/distributions/zcode-ide-0.1.0.zip | grep 'web/assets/index-'
ls vendor/ZCode/packages/web-ide/dist/assets/index-*.js
```

## 5. 部署到本机 IDE

用户说「部署到 IDE / 打包插件 / 装到 IDEA 里试试」时，加载并执行 `.agents/skills/deploy-zcode-plugin/SKILL.md`。核心是：构建 → 完全退出 IDE（确认没有 `idea64` 进程）→ 整个删掉 `plugins/zcode-ide` 再解压 → 重启 → 用日志确认 `web=` 指向哪份前端。

> Gradle 必须用 JDK 21；Git Bash 里 `java` 可能指向 Java 8。
