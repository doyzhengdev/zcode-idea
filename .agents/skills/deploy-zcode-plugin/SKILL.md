---
name: deploy-zcode-plugin
description: 把 zcode-ide 插件的构建产物部署到本机 IntelliJ IDEA，流程是"打包 → 关闭 IDE → 替换插件目录 → 重启 → 验证"。当用户说"打包插件""部署到 IDE""装到 IDEA 里试试""替换插件后重启""重新打包看看效果"，或者改完 Kotlin / web-ide 代码需要在真实 IDE 里验证时，使用本 skill。只改代码、不要求在 IDE 里看效果时不要用。
---

# 部署 ZCode IDE 插件到本机 IDEA

本 skill 替代 Settings → Plugins → Install Plugin from Disk：直接替换已安装插件目录里的文件，重启 IDE 即可生效。IntelliJ 的自定义插件没有额外注册表，`plugins/` 下就是一个目录，启动时扫描；`system/plugins/*.zip` 只是安装缓存，启动不读它。

## 本机固定路径

| 项 | 值 |
|---|---|
| 项目根 | `E:\work\doyzheng\zcode-ide` |
| 构建产物 | `build\distributions\zcode-ide-0.1.0.zip` |
| 已安装插件目录 | `C:\Users\<user>\AppData\Roaming\JetBrains\IntelliJIdea2026.2\plugins\zcode-ide` |
| IDE 可执行文件 | `C:\Program Files\JetBrains\IntelliJ IDEA 2026.2.2\bin\idea64.exe` |
| IDE 日志 | `C:\Users\<user>\AppData\Local\JetBrains\IntelliJIdea2026.2\log\idea.log` |
| JDK（构建） | `C:\Users\<user>\.jdks\jdk-21.0.12.1+1` |

路径变了就先用 `ls "$APPDATA/JetBrains"` 和 `ls "$LOCALAPPDATA/JetBrains"` 确认，不要照抄。

## 0. 辅助脚本（`scripts/`）

部署与验证过程中反复用到的工具，**直接用，不要每次临时重写**。完整说明与踩坑见 [`scripts/README.md`](./scripts/README.md)。

| 脚本 | 用途 |
|---|---|
| `stop-ide.ps1` | 优雅关闭 IDE（`CloseMainWindow` + 等进程消失，超时才 `-Force`） |
| `start-ide.ps1` | 启动 IDE 并打开工程；`-WaitSeconds 50` 可等启动 |
| `ide-capture.ps1` | 截图：`-Mode window\|region\|screen`；`-ToggleToolWindows` 先按 Ctrl+Shift+F12 |
| `ide-editor-menu.ps1` | 拖选代码 → 右键 → 截取菜单（区域截图，Swing 弹出菜单截得到） |
| `ide-click.ps1` | 窗口内点击坐标，`-Right` 为右键 |
| `cdp-eval.mjs` | 在 ZCode 页面的 JCEF CDP 里执行表达式（自动找 `DevToolsActivePort`） |
| `cdp-clear-composer.mjs` | 用真实键盘事件清空 Lexical 输入框 |

所有 `.ps1` 的坐标都相对 **IDE 主窗口左上角**；先截图再传坐标。`.ps1` 必须保存为 UTF-8 with BOM。

## 1. 构建

按改动范围决定要跑哪几步，顺序不能颠倒：

**只改了 Kotlin 或 plugin.xml**

```bash
cd /e/work/doyzheng/zcode-ide
JAVA_HOME=/c/Users/<user>/.jdks/jdk-21.0.12.1+1 ./gradlew buildPlugin --console=plain
```

**改了 `vendor/ZCode/packages/web-ide`**（前端）

```bash
cd /e/work/doyzheng/zcode-ide/vendor/ZCode
export PATH="/c/Users/<user>/scoop/persist/nvm/nodejs/v24.14.0:$PATH"
pnpm --filter @zcode/web-ide build

cd /e/work/doyzheng/zcode-ide
node scripts/build-runtime.mjs
JAVA_HOME=/c/Users/<user>/.jdks/jdk-21.0.12.1+1 ./gradlew buildPlugin --console=plain
```

`buildPlugin` 只把 `dist/` 打进 zip（安装态目录名为 `runtime/`），不会自己编译前端，所以改了前端必须重跑 `build-runtime.mjs`，否则 zip 里还是旧 bundle。

**校验 zip 里的前端确实是刚构建的那份**

```bash
cd /e/work/doyzheng/zcode-ide
unzip -l build/distributions/zcode-ide-0.1.0.zip | grep 'web/assets/index-'
ls vendor/ZCode/packages/web-ide/dist/assets/index-*.js
```

两边的文件名（`index-XXXXXXXX.js` 里的 hash）必须一致。

**确认 runtime 溯源（可选）**

```bash
unzip -p build/distributions/zcode-ide-0.1.0.zip zcode-ide/runtime/BUILD-INFO.json
```

`fork.commit` 应与 `vendor/zcode.lock` 一致；`dirty: true` 表示本地工作区构建、非 CI 产物。

> Gradle 必须用 JDK 21。Git Bash 里 `java` 可能指向 Java 8，会直接报 "This build uses a Java 8 JVM"。

## 2. 关闭 IDE

Windows 下 IDE 运行时会锁住 `lib/*.jar`，覆盖会报"文件正在被另一个程序使用"；而且 JVM 不会热重载已加载的类，只有重启才生效。

优先让 IDE 自己退出（Alt+F4 或 File → Exit），这样它会写回 LAF、窗口布局等配置：

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-ide.ps1
```

脚本等价于 `CloseMainWindow()` + 轮询进程消失；确认没有未保存文件时才加 `-Force` 强杀。

**退出前别信任上一次查到的 pid**：IDEA 启动过程中可能出现多个 `idea64` 进程，窗口最终归属的 pid 和最初 `Start-Process` 拿到的并不总是同一个，早先的 pid 会在几秒后消失。要用 GUI 自动化关窗口时，每次操作前按窗口标题重新绑定（`list_apps` 里找 `zcode-ide [E:/work/doyzheng/zcode-ide]`），不要复用旧 pid 或旧 `window_id`。判断退出也要看 `Get-Process` 是否**全部**为空，而不是某一个 pid。

卡住超过 20 秒再兜底强杀（`Stop-Process -Name idea64 -Force`），但强杀可能丢未保存的编辑器内容，先确认没有未保存文件。

## 3. 替换插件目录

```bash
PLUGINS="$APPDATA/JetBrains/IntelliJIdea2026.2/plugins"
rm -rf "$PLUGINS/zcode-ide"
unzip -q /e/work/doyzheng/zcode-ide/build/distributions/zcode-ide-0.1.0.zip -d "$PLUGINS"
```

- **整个目录删掉再解压**，不要只覆盖差异。前端产物文件名带内容 hash，占位覆盖会残留一堆旧 bundle；`lib` 下不同版本名的 jar 会同时被加载，容易出现类冲突。
- zip 根目录必须解出来是 `zcode-ide/`。解到 `plugins/` 下即可。
- 版本号保持 `0.1.0` 没问题，IDEA 启动时不会因为版本没变而跳过加载，只是不显示"可更新"。
- 不需要动 `system/plugins/zcode-ide.zip`，那是 Install from Disk 留下的缓存。

## 4. 重启 IDE

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-ide.ps1 -WaitSeconds 50
```

等窗口出现（约 30–45 秒）再验证，别在启动过程中抓状态。

## 5. 验证

**第一步看日志，确认加载的是插件目录里的 runtime：**

```bash
grep -a "Starting ZCode server" "$LOCALAPPDATA/JetBrains/IntelliJIdea2026.2/log/idea.log" | tail -1
```

期望 `web=` 指向 `...\plugins\zcode-ide\runtime\web`。

如果指向 `E:\work\doyzheng\zcode-ide\vendor\ZCode\packages\web-ide\dist`，说明 `RuntimeLayout` 选中了仓库布局（`<user.dir>/vendor/ZCode` 优先级高于插件目录）。这时**打包进去的 runtime 并没有被验证**，界面里跑的是源码目录的 dist。两者内容一致时看不出差别，改完前端没重打包时就会踩坑。

**第二步看界面：** 右侧 ZCode 工具窗口正常渲染，主题跟随 IDE 明暗。

```bash
# 桥是否注入、当前页面是否 IDE 宿主
node scripts/cdp-eval.mjs "JSON.stringify({ bridge: typeof window.__ZCODE_IDE_QUERY__, ideHost: location.href.includes('ideHost=1') })"

# 需要看图时（window 截不到右键菜单，用 region）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ide-capture.ps1 -Mode region -OutFile "$TEMP/ide.png"
```

**第三步（可选）发一条消息**，确认 Agent 回复，说明 server 和 attachment 都正常。

## 常见故障

| 现象 | 原因 |
|---|---|
| 覆盖时报"文件正在被另一个程序使用" | IDE 没退干净，检查 `idea64` 进程 |
| 面板空白 / 404 | `runtime/web` 没解压完整，检查 `runtime/web/index.html` 是否存在 |
| 改了前端界面没变化 | 走的是仓库 dist；看日志 `web=` 路径 |
| 启动后工具窗口消失 | 插件没加载成功；搜日志里 `dev.zcode.ide` 的报错 |
| 界面突然变成英文/主题变了 | 那是 IDE 自身配置，不是插件；插件主题取自 `JBColor.isBright()` |
| GUI 自动化报"no tree / no visible window" | 绑到了已退出的旧 pid；按窗口标题重新绑定 |
| 右键菜单截图里没有菜单 | `PrintWindow` 截不到 Swing 弹出窗口；用 `ide-capture.ps1 -Mode region` 或 `ide-editor-menu.ps1` |
| `SendKeys` 按了没反应 / 键跑到别的窗口 | `Ctrl+Shift+A` 等组合可能被输入法或键位吞掉；先校验前台窗口，必要时改用鼠标（`ide-editor-menu.ps1` + `ide-click.ps1`） |
| 右键点到编辑器最左侧弹出「断点」 | 落在断点槽上了；x 往代码区多移几十像素 |
| 点菜单项后菜单直接消失、没有执行 | 点在菜单左边缘/阴影上；`ide-click.ps1` 的 x 往菜单内部再移约 100px |
| 用 `execCommand` 清不空 ZCode 输入框 | 输入框是 Lexical；用 `cdp-clear-composer.mjs` 发真实键盘事件 |
| 每次启动日志里的 `web=` 路径不一样 | 正常现象，取决于启动时的 `user.dir` 下是否有 `vendor/ZCode`；以日志为准判断这次验证的是哪份前端 |

## 边界

关闭 IDE 会中断用户当前工作。只有用户明确要求"部署 / 替换 / 重启 IDE"时才执行这套流程；如果用户只是在问怎么部署，给步骤，不要动手关他的 IDE。
