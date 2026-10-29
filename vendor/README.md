# vendor/

存放外部源码工作副本，不入库（见 `.gitignore` 的 `/vendor/ZCode`）。fork 的版本锁在 `vendor/zcode.lock`（入库）。

## 一键准备（推荐）

```bash
node scripts/bootstrap.mjs
```

按 `vendor/zcode.lock` 把官方源码放到 `vendor/ZCode`（可用 `ZCODE_REPO` 指向已有的工作副本），checkout 锁定的 commit。

| 参数 | 用途 |
|---|---|
| `--check` | 只校验锁与 HEAD，不 clone、不切换（CI 用） |
| `--update` | 把 fork 当前 HEAD 写回锁（提交代码后执行） |

锁字段：

| 字段 | 含义 |
|---|---|
| `repo` | fork 的 clone 地址（可用 `ZCODE_FORK_REPO` 覆盖） |
| `branch` | 开发分支 |
| `commit` | 构建/发版使用的提交；本地未提交改动不进入锁 |
| `upstreamBase` | 计算补丁面的上游基线 |
| `toolchain` | 构建所需 Node / pnpm / JDK 主版本 |

`scripts/build-runtime.mjs` 会校验 fork HEAD 与锁是否一致：本地只提示，`CI=1` 或 `ZCODE_STRICT_LOCK=1` 时直接失败。每次构建还会把 commit、dirty 标记和插件版本写进 `dist/BUILD-INFO.json`，随 zip 一起分发到 `runtime/BUILD-INFO.json`。

## vendor/ZCode

官方源码 fork 的工作副本（分支 `ide-integration`），是**独立的 git 仓库**（自带 `.git`）。用途：

- `scripts/build-runtime.mjs` 的默认源（可用环境变量 `ZCODE_REPO` 覆盖）
- `RuntimeLayout` 开发期候选（`<user.dir>/vendor/ZCode`，优先于插件自带 runtime）
- 在本工程内浏览/跳转官方源码

fork 侧的操作直接在目录里做，插件仓库对它是忽略的：

```bash
git -C vendor/ZCode status
git -C vendor/ZCode add -A && git -C vendor/ZCode commit -m "..."
git -C vendor/ZCode push origin ide-integration
```

把它整体移走或重建时保留 `.git` 即可；删除前先确认没有未提交、未推送的提交（`git -C vendor/ZCode status`、`git -C vendor/ZCode log origin/ide-integration..`）。

## 在 IDE 里同时管理两个仓库

插件仓库与 `vendor/ZCode` 是两条独立的 Git 历史。IDE 默认只把项目根登记为 Git root，所以 Git 工具窗口里看不到 fork；在 `Settings → Version Control → Directory Mappings` 加一条 `$PROJECT_DIR$/vendor/ZCode`（VCS 选 Git），Git 窗口顶部就会出现两个 root，提交/推送各走各的 remote。

本机已写入 `.idea/vcs.xml`（`.idea/` 被忽略，不进仓库）：

```xml
<mapping directory="" vcs="Git" />
<mapping directory="$PROJECT_DIR$/vendor/ZCode" vcs="Git" />
```

在 fork 里提交后，回到插件仓库依次执行：`node scripts/patch-budget.mjs` 核对补丁面 → 更新 [`CHANGES-VS-UPSTREAM.md`](../.agents/docs/upstream/CHANGES-VS-UPSTREAM.md) → `node scripts/bootstrap.mjs --update` 更新 `vendor/zcode.lock`。
