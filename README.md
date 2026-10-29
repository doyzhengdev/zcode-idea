# ZCode IDE（JetBrains 插件）

[![npm version](https://img.shields.io/npm/v/zcode-idea?style=flat-square&logo=npm)](https://www.npmjs.com/package/zcode-idea)
[![npm downloads](https://img.shields.io/npm/dm/zcode-idea?style=flat-square)](https://www.npmjs.com/package/zcode-idea)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](./LICENSE)
[![JetBrains](https://img.shields.io/badge/JetBrains-2025.1%2B-black?style=flat-square&logo=jetbrains)](https://www.jetbrains.com/)

![ZCode 在 IntelliJ IDEA 侧栏里](./docs/images/panel.png)

在 JetBrains IDE 侧栏里直接用 **官方 ZCode**：界面是官方 Web UI，后端跑官方
`@zcode/server`，插件只提供本机 Node 与 IDE 自带的浏览器内核（JCEF），**不依赖 Electron**。

同一套界面、同一套 Agent、同一个 `~/.zcode` 数据目录——不是"仿 ZCode 的插件"，
而是官方产品换了一层 IDE 外壳。

```bash
npx zcode-idea@latest update
```

一条命令自动发现本机 IDE、比对版本、关闭并替换插件目录、重启 IDE。

## 为什么还要一个 IDE 插件

官方 ZCode 客户端是独立应用，它不知道你 IDE 里开着哪个项目、选中了哪段代码。插件的价值是
把 Agent 放进代码所在的地方：

- **官方代码原样复用**：界面、会话、Agent 行为全部来自官方代码；插件对官方源码的改动约
  0.04% 的行（19 个文件）。
- **项目就是上下文**：侧栏绑定当前工程，右键文件/目录、编辑器选区一键加入对话。
- **外壳交给 IDE**：窗口、托盘、通知、更新、快捷键由 IDE 承担，不再带一个 Electron 外壳。

## 功能

| 分组 | 能力 |
|---|---|
| 对话与任务 | 官方对话界面、流式回复、项目/会话列表、模型与思考强度、草稿与最近使用 |
| IDE 集成 | 点文件在编辑器打开（带行列号）、目录定位到项目树、右键发送文件引用、选区发送 `路径#Lx-Ly` |
| 宿主能力 | 文件/目录对话框、另存为、打开外部链接、系统通知、MCP 目录读写、记忆详情 |
| 运行时 | 全 IDE 共享一个 server、固定端口与 token 持久化、Node 24 自动供给、完整包内置 runtime |
| 远控 | 面板内生成二维码，手机浏览器接管当前 IDE 项目 |

索引期间面板照常可用；会话与桌面端互通（同一 `~/.zcode`，但**不要同时运行**，SQLite 会锁）。

## 明确不支持

以下能力在 IDE 形态下不提供（底层能力缺失，不是入口被藏）：远程工作区 / remote attach、
Docker、WSL / SSH、Computer Use、内置浏览器侧栏。桌面外壳类能力（窗口控件、托盘、应用菜单、
剪贴板/电源、应用内自动更新、跨窗口标签同步、窗口截图）由 IDE 本身承担。

另外，IDE 形态下会隐藏少量桌面专属入口（新建项目、项目分组与搜索、插件市场、内置终端、
右侧面板等），相应能力在 IDE 里有等价做法。

## 环境要求

| 项 | 要求 |
|---|---|
| IDE | IntelliJ Platform 2025.1+（`since-build 251`，`until-build 263.*`），需要 JCEF |
| 运行 | Node ≥ 24（插件优先用本机，缺失时自动下载到 `~/.zcode/ide/runtime-node`） |
| 支持的产品 | IntelliJ IDEA、WebStorm、PyCharm、GoLand、CLion、DataGrip、RubyMine、PhpStorm 等 |

## 构建（开发）

| 项 | 要求 |
|---|---|
| 构建工具 | JDK 21、Node ≥ 24、pnpm 10、Gradle 8.13（wrapper 自带） |
| 平台 | 构建必须在 **Windows** 上（原生依赖平台相关） |

首次准备 fork 工作副本（按 `vendor/zcode.lock` 锁定 commit）：

```bash
node scripts/bootstrap.mjs
```

只改 Kotlin / plugin.xml：

```bash
JAVA_HOME=/path/to/jdk-21 ./gradlew buildPlugin --console=plain
# 产物：build/distributions/zcode-ide-<版本>.zip（默认薄包，不含 runtime）
# 完整包：./gradlew buildPlugin -PbundleRuntime=true
```

改了 `vendor/ZCode` 下的前端或官方源码，顺序不能颠倒：

```bash
cd vendor/ZCode && pnpm --filter @zcode/web-ide build
cd ../.. && node scripts/build-runtime.mjs      # 组装 dist/，不跑这步 zip 里还是旧 bundle
JAVA_HOME=/path/to/jdk-21 ./gradlew buildPlugin --console=plain
```

CI / 一条命令出包：

```bash
node scripts/ci-build.mjs                 # clone/install/build/runtime/buildPlugin + sha256
node scripts/ci-build.mjs --skip-install  # 复用已有 node_modules
```

工程地图、桥契约、构建与部署细节见 [`.agents/docs/`](./.agents/docs/README.md)。

## 相关链接

- 官方 ZCode 源码（上游）：https://github.com/zai-org/ZCode
- 本项目的 ZCode fork（`ide-integration` 分支承载补丁）：https://github.com/doyzhengdev/ZCode
- ZCode 产品主页：https://zcode.z.ai

## 说明

本项目是社区插件，与 Z.ai / ZCode 官方没有隶属关系；ZCode 是 Z.ai 的产品。
