# 2026-10-26 · npm 安装器 `zcode-idea`（npx 安装插件到本机 IDE）

- **范围**：`scripts/npm/`（新增 npm 包）、`scripts/publish-npm.mjs`（薄封装）、文档
- **触发**：用户需求——提供 `npx zcode-idea`，把插件 zip 安装到本机已安装的 JetBrains IDE
- **提交**：working tree（未提交）

> **后续变更**：`scripts/publish-npm.mjs` 与后续两个发布脚本已在
> [2026-10-26-6](./2026-10-26-6-release-script-merge.md) 合并为 `scripts/release.mjs`；
> 下文的旧发布命令仅作历史记录。

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/package.json` | 重写 | 包名改为 `zcode-idea`，版本 `0.0.1`，`type: module`，`bin`、`files`、`engines`、`publishConfig`、`prepack`、`test` |
| `scripts/npm/package-lock.json` | 新增 | `npm install --save-exact` 生成 |
| `scripts/npm/bin/zcode-idea.mjs` | 新增 | CLI 入口：cac 解析 + 六步主流程 |
| `scripts/npm/lib/products.mjs` | 新增 | 16 个产品的配置目录前缀、进程名、可执行文件、Toolbox key、名称匹配 |
| `scripts/npm/lib/targets.mjs` | 新增 | `--target` 解析、Windows/macOS/Linux 发现、去重与排序 |
| `scripts/npm/lib/manifest.mjs` | 新增 | manifest 校验、sha256、zip 条目安全校验、`plugin.xml` id 校验 |
| `scripts/npm/lib/processes.mjs` | 新增 | 进程枚举、优雅关闭/超时强杀（tasklist/taskkill、ps/pkill） |
| `scripts/npm/lib/unzip.mjs` | 新增 | 删旧目录、解压、权限位、TTY/非 TTY 进度、失败清理 |
| `scripts/npm/lib/launch.mjs` | 新增 | 按平台/版本查找 IDE 可执行文件并 detached 启动 |
| `scripts/npm/lib/prompt.mjs` | 新增 | checkbox 多选与关闭确认（按需动态加载 inquirer） |
| `scripts/npm/lib/log.mjs`、`lib/errors.mjs` | 新增 | 统一 `[zcode-idea]` 输出、`UsageError`/`InstallError` |
| `scripts/npm/scripts/copy-dist.mjs` | 新增 | `prepack`：从 `build/distributions` 复制最新 zip、校验 sha256、写 `dist/manifest.json` |
| `scripts/npm/test/*.test.mjs`、`test/helpers/zip.mjs` | 新增 | 38 个 node:test 用例 + 最小 ZIP 写入器（含符号链接/权限位） |
| `scripts/npm/README.md` | 新增 | 用法、支持的 IDE/平台、flags、离线内网说明、维护流程 |
| `scripts/npm/.gitignore` | 新增 | 忽略 `node_modules/`、`dist/*.zip`、`dist/manifest.json`、`*.tgz` |
| `scripts/publish-npm.mjs` | 修改（原 0 字节） | 实现为薄封装：在 `scripts/npm` 下运行 prepack + `npm publish --registry <Nexus>`，参数透传（`--dry-run` 可用） |
| `.agents/docs/changes/README.md` | 修改 | 索引新增一行 |

## 为什么改

需要一个可分发、可重复执行的安装方式：用户不必手动找配置目录、关 IDE、解压 5899 个文件。
npm 包内直接携带插件 zip（49.1 MB），`npx zcode-idea` 即可离线安装；
安装器必须跨平台、只操作目标 IDE、失败可诊断。

关键设计取舍：

1. **依赖版本固定为兼容 Node 18 的版本**：`cac@6.7.14`、`@inquirer/prompts@7.10.1`、
   `yauzl@3.4.0`。最新版 cac 7 与 `@inquirer/prompts` 8 要求 Node >= 20，而
   `engines` 按需求声明为 `>=18`，两者不能自相矛盾。
2. **`scripts.test` 使用 `node --test test/*.test.mjs`**：本机 Node v22.23.4 下
   `node --test test/` 会把目录当模块加载并报 `MODULE_NOT_FOUND`；glob 由 Node 自身展开，
   Windows cmd 下同样可用。
3. **`publish-npm.mjs` 保留为薄封装**而不是删除：发布只需一条命令，且 registry 固定为内网，
   避免误发公网。
4. **关闭 IDE 在非 TTY 且未传 `--yes` 时跳过**（打印警告），而不是让 `taskkill` 静默执行；
   交互模式仍会二次确认。
5. **zip-slip 双层防御**：yauzl 自身会拒绝含 `..` 的条目，我们仍对每个条目做前缀/绝对路径/
   反斜杠/符号链接校验，并把 yauzl 的解析错误包装成中文可操作提示。

## 行为变化

- 新增命令 `npx zcode-idea`，默认交互式发现并多选 IDE；`--all` / `--target` 可无交互运行。
- 安装前强制校验包完整性（manifest/sha256/大小/zip 结构/主 jar 内 `dev.zcode.ide`）。
- 只关闭所选目标对应产品的进程；同一产品多版本只关一次；超时后强杀。
- 重新安装会先删除 `<pluginsDir>/zcode-ide`，幂等。
- 找不到可执行文件只提示手动打开，不算失败；单个目标失败不影响其它目标。
- 不影响插件 Kotlin 代码、`vendor/ZCode` 或已安装的插件行为。

## 验证

全部在本机 Windows（Node v22.23.4 / npm 10.9.9）执行：

| 命令 | 结果 |
|---|---|
| `cd scripts/npm && npm install --save-exact --no-audit --no-fund cac @inquirer/prompts yauzl` | 成功，生成 `package-lock.json` |
| `npm test` | 38 个用例全部通过（配置目录解析、进程映射、zip-slip/符号链接、manifest 各失败分支、target 解析、三平台发现、解压幂等与失败清理、CLI 退出码） |
| `npm run prepack` | 复制 `zcode-ide-0.1.0.zip`，sha256 `b3bb4620163cea74481ca26d633d1563b46865d3985285d6dc7e7d30be13a612`，与 `build/distributions` 完全一致，49.1 MB，插件版本 0.1.0 |
| `node bin/zcode-idea.mjs --dry-run --all --no-launch` | 校验 5899 条目 / 5381 文件；发现 `IntelliJIdea2026.2`（配置目录）与 `IntelliJ IDEA 2026.2.2`（安装目录）；未改任何文件 |
| `node bin/zcode-idea.mjs --target "$TEMP/zcode-idea-installer-test/plugins" --yes --no-launch` | 5.7 秒解压 5381 个文件 / 191 MB；`zcode-ide/lib/zcode-ide-0.1.0.jar`、`zcode-ide/runtime/web/index.html` 存在；目录数 518，与 zip 条目 5899 吻合 |
| 上述命令再执行一次 | 旧目录内人工放置的 `SENTINEL-OLD.txt` 被清除，文件数仍为 5381，plugins 根目录只有 `zcode-ide/` |
| `npm pack --dry-run` / `npm pack` | 14 个文件，`zcode-idea-0.0.1.tgz` 49,642,327 字节（47.34 MB），包含 `bin/`、`lib/`、`dist/*.zip`、`dist/manifest.json`、README |
| 从 tarball `npm install -g --prefix <临时目录>` 后执行 `zcode-idea --version` / `--dry-run --all` | 版本输出 `zcode-idea/0.0.1`；dry-run 正常校验与发现（证明发布的包内 bin/lib/dist 完整） |
| `node scripts/publish-npm.mjs --dry-run` | prepack + `npm publish --dry-run` 成功，指向内网 Nexus，未推送 |
| `npm whoami --registry https://<internal-registry>/repository/npm-repo-hosted/` | 返回 `<npm-user>` |

**未验证**：macOS/Linux 的真实 IDE 发现、进程关闭与启动（仅单测覆盖路径逻辑）；
有 IDE 运行时的真实关闭流程（执行时本机无 IDE 进程）；超长路径（>260 字符）的 Windows 解压。
`npm publish` 按要求未执行。

## 风险 / 后续

- 打包体积：zip 49.1 MB，tarball 47.34 MB，接近内网 npm 仓库的常见单包上限；
  若需瘦身，可改为发布时从对象存储下载插件包（会引入联网依赖，与当前离线设计冲突）。
- 安装目录（次级选项）在 IDE 升级/重装时可能被清掉；交互展示与 README 已标注。
- 关闭 IDE 使用进程名匹配：同一产品不同版本会一起关闭（配置目录无法区分），属预期取舍。
- macOS 的 Toolbox 布局与 Linux 包管理器（如 snap）路径存在多种变体，代码已覆盖常见布局，
  但未在真机验证。
- Windows 下 Node 的 `chmod` 基本无效；解压仍尝试保留权限位，仅对 Unix 生效。
- `npx` 在内网需要先把 registry 指向 Nexus，否则会去公网查找；README 已说明。

## 相关

- [`../../npm/README.md`](../../npm/README.md)
- [AGENTS.md 红线 11（变更记录）](../../../AGENTS.md)
- `.agents/skills/deploy-zcode-plugin/scripts/stop-ide.ps1`（关闭 IDE 的既有参考实现）
