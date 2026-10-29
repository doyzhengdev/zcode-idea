# 2026-10-26 · npm 安装器：安装目录写探针与帮助文案修正

- **范围**：`scripts/npm/lib/targets.mjs`、`scripts/npm/bin/zcode-idea.mjs`、`scripts/npm/test/`、`scripts/npm/README.md`
- **触发**：监督测试发现两个问题——
  1. `--all` 会把 `C:\Program Files\JetBrains\IntelliJ IDEA 2026.2.2\plugins` 选入，
     普通权限下写入失败，导致整体退出码 1（即使配置目录已安装成功）；
  2. `--help` 里 `--no-launch` 显示 `(default: true)`，与“默认会启动”的语义冲突。
- **提交**：working tree（未提交）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/npm/lib/targets.mjs` | 修改 | 新增真实写探针 `probeInstallTargetWritable` / `defaultWriteProbe`；新增 `discoverTargetsDetailed` 返回 `{ targets, skipped }`；install 目标不可写时跳过并记录；config 目标始终保留；删除不可靠的 `fs.access(W_OK)` 判定 |
| `scripts/npm/bin/zcode-idea.mjs` | 修改 | 使用 `discoverTargetsDetailed`，跳过数 > 0 时输出一行中文 warn；`--no-launch` 文案改为“安装完成后不启动 IDE（默认会启动）”，并清除 cac 为 `--no-*` 自动补的帮助默认值；dry-run 完成语补充写探针说明 |
| `scripts/npm/test/targets.test.mjs` | 修改 | 新增 5 个写探针用例（可写、plugins 缺失探测父目录、优先探测 plugins、注入失败、plugins 是文件） |
| `scripts/npm/test/discovery.test.mjs` | 修改 | 新增 `discoverTargetsDetailed` 过滤用例（注入不可写判定，config 保留、install 进入 skipped）与 `discoverTargets` 兼容用例 |
| `scripts/npm/README.md` | 修改 | 说明写探针、跳过提示、`--no-launch` 默认行为、dry-run 的临时探针 |
| `.agents/docs/changes/README.md` | 修改 | 索引新增一行 |

## 为什么改

- **`fs.access(W_OK)` 在 Windows 上不可靠**：它主要反映只读属性，不检查 ACL。
  `C:\Program Files` 对普通用户实际不可写，但仍可能被判定“可写”，导致 `--all`
  选中后解压失败、整体退出码 1。必须实际创建并删除一个临时文件才能真正确认权限。
- **dry-run 也要过滤**：否则用户会看到计划里包含一个必然失败的目标。
  探针只创建并立即删除临时文件，失败也会尝试清理，不留下持久改动。
- **帮助文案**：cac 的 `Option` 会为 `--no-*` 自动设置 `config.default = true`，
  帮助输出因此追加 `(default: true)`。这里在注册后把该默认值清为 `undefined`：
  不传 `--no-launch` 时 `options.launch` 仍是 `undefined`（走启动分支），
  传了则由 mri 置为 `false`，语义不变。若未来 cac 内部结构调整导致取不到该 option，
  代码不会报错，只是帮助里重新显示默认值，行为不受影响。

## 行为变化

- `--all` / 交互发现时，不可写的 IDE 安装目录被过滤，并输出一行：
  `[zcode-idea] 警告：已跳过 N 个不可写的 IDE 安装目录（需要管理员权限）。`
- 配置目录（`config`）不做写探针，始终保留。
- `--target` 显式指定的目标不做过滤（用户明确要求时仍会尝试安装）。
- `--help` 中 `--no-launch` 显示为“安装完成后不启动 IDE（默认会启动）”，不再追加 `(default: true)`。
- dry-run 的完成提示改为说明写探针只创建并立即删除临时文件。

## 验证

| 命令 | 结果 |
|---|---|
| `npm test` | 45 个用例全部通过（新增 7 个写探针/过滤用例） |
| `node bin/zcode-idea.mjs --dry-run --all --no-launch` | 输出 `已跳过 1 个不可写的 IDE 安装目录（需要管理员权限）`，可用目标只剩 `IntelliJIdea2026.2` 配置目录；计划中不再包含 Program Files 目标 |
| `node bin/zcode-idea.mjs --help` | `--no-launch 安装完成后不启动 IDE（默认会启动）`，无 `(default: true)` |
| `node bin/zcode-idea.mjs --target "$TEMP/zcode-idea-installer-test-2/plugins" --yes --no-launch` | 5.8 秒解压 5381 文件 / 518 目录 / 191 MB；jar 与 `runtime/web/index.html` 存在；`plugins/` 下只有 `zcode-ide/` |
| 同上但不传 `--no-launch` | 进入启动分支，提示“首次打开面板会下载 runtime”，随后因目标未识别而提示手动打开（未真正启动进程），证明默认启动语义未变 |

**未验证**：有 IDE 运行时的真实关闭；macOS/Linux 真机（写探针逻辑由单测覆盖）。

## 风险 / 后续

- 管理员权限下运行安装器时，Program Files 目标会通过写探针并出现在 `--all` 中——这是预期行为
  （权限足够时安装目录可用），但升级 IDE 仍可能清掉该副本。
- macOS 的 `/Applications/*.app` 通常属于 root，普通用户会被跳过并提示，属预期。
- 写探针会在目标目录短暂创建 `.zcode-idea-write-test-*` 文件；创建成功后立即删除，
  删除失败时也会尽力清理，且该目录会被判定为不可写。
- 依赖 cac 内部 `globalCommand.options` 仅是帮助展示的修饰；失败时降级为显示默认值，不影响功能。

## 相关

- [npm 安装器初版](./2026-10-26-3-npm-installer.md)
- [`../../npm/README.md`](../../npm/README.md)
