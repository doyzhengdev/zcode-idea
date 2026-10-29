# 2026-10-29 · 发布 0.0.6 完整包，修复其他机器"运行时下载失败"

- **范围**：版本号与发布（full package，runtime 内置）
- **触发**：bug —— 另一台机器安装 0.0.5 后打开面板报
  `ZCode 启动失败: 下载 ZCode 运行时失败: ConnectException`
- **提交**：working tree

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `package.json` / `scripts/npm/package.json` / `scripts/npm/package-lock.json` | 修改 | 版本 0.0.5 → 0.0.6 |

本次不发代码逻辑改动：发布产物改为**完整包**（`--bundle-runtime`），行为差异见下。

## 为什么改（根因）

薄包（4MB）本身不含 runtime，首次打开面板要按内置 baseline 清单下载 47MB runtime。这条链路在
**任何没有开发环境变量的机器上都是断的**，四个原因叠加：

1. **默认下载地址是占位符**：`RuntimeProvisioner.DEFAULT_BASE_URL = "https://cdn.example.com/"`
   （更新检查用的 `RuntimeUpdater.DEFAULT_MANIFEST_URL` 同样是 `cdn.example.com`）。只有开发机
   通过 `ZCODE_IDE_RUNTIME_BASE_URL` / `ZCODE_IDE_RUNTIME_MANIFEST_URL` 覆盖过才正常。
   其他机器 DNS 解析失败 → `ConnectException`，即用户看到的报错。
2. **runtime 从未上传到 CDN**：`/zcode-ide/runtime/stable/0.1.0-b177da31c187/zcode-runtime.zip`
   与 `/zcode-ide/runtime/stable/manifest.json` 在七牛上均为 404。
3. **仅有 HTTP 测试域名**：插件对非 HTTPS 源要求显式 `ZCODE_IDE_RUNTIME_ALLOW_HTTP=1`，
   即使补传对象，终端用户仍会被拒。
4. **本地 `build/runtime` 与内置 baseline 不一致**：本地是 `runtime/test/0.1.1-…`、
   sha256 `177e95f8…`；内置 baseline 是 `runtime/stable/0.1.0-…`、sha256 `cc8b326b…`，
   直接上传会对不上。

此外 `RuntimeManifest.PLUGIN_VERSION` 是硬编码常量（当前 `"0.1.0"`），与真实插件版本
（0.0.5/0.0.6）不一致，兼容性判断实际没有约束力 —— 属于需要单独修的遗留项。

## 行为变化

- 插件 zip 49,965,147 bytes（约 47.6MB，5899 个文件），内含 `runtime/`（web + server +
  BUILD-INFO），安装后直接使用插件自带 runtime，**不再走下载链路**。
- `RuntimeProvisioner.ensure()` 的 `RuntimeLayout.resolve()` 优先级第 4 级命中插件目录
  `runtime/`，因此完整包与薄包在运行时是同一段逻辑，只是前者不会落到下载分支。
- 安装器识别为完整包并提示"已内置 runtime，打开面板无需额外下载"。

## 验证

- `node scripts/release.mjs --apply --bundle-runtime`：产出 `zcode-ide-0.0.6.zip`，
  49,965,147 bytes，sha256 `13871383b0cbe67cabac2bfcbbd5aa90c8f6555e525fc81d9e0dd1e6c021e5ed`；
  zip 内含 `runtime/web/index.html`、`runtime/BUILD-INFO.json`、`lib/zcode-ide-0.0.6.jar`。
- 本地安装验证：`zcode-idea update --zip …0.0.6.zip --target <临时目录> --no-launch` →
  安装 5381 个文件，`runtime/web/index.html` 存在，安装器提示"完整包，无需额外下载"。
- 远端：`--apply --skip-build --push --npm --allow-http` 上传成功（49.9MB），
  npm 发布 `zcode-idea@0.0.6`；`/0.0.6/manifest.json` 的 `size`/`sha256` 与本地一致，
  zip `HEAD` 200 且 `Content-Length=49965147`。
- 另一台机器（Administrator / IDEA 2025.3 + WebStorm 2025.3）：待用 0.0.6 复测。

## 风险 / 后续

- 插件包从 4MB 变成 47.6MB，安装器下载耗时增加；这是"runtime CDN 未接通"期间的取舍。
- 要恢复薄包，必须先补齐：① HTTPS 分发域名；② `node scripts/publish-runtime.mjs --apply`
  上传与 baseline 一致的 runtime（并按需重新生成 baseline）；③ 把
  `DEFAULT_BASE_URL` / `DEFAULT_MANIFEST_URL` 改为真实域名；④ `RuntimeManifest.PLUGIN_VERSION`
  改为读取真实插件版本。
- 稳定指针仍受七牛域名级缓存影响（本次上传后刷新接口 404，需控制台操作），版本化清单不受影响。

## 相关

- [`2026-10-29-7-release-0-0-4.md`](./2026-10-29-7-release-0-0-4.md)、[`2026-10-29-9-release-0-0-5.md`](./2026-10-29-9-release-0-0-5.md)
- [`RUNTIME-DISTRIBUTION.md`](../build/RUNTIME-DISTRIBUTION.md)
