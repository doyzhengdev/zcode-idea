# 环境、网络与调试

> 本机工具链版本、镜像配置、日志排查入口，以及用 CDP 观测真实 UI 的方法。
> 构建命令见 [`BUILD-AND-DEPLOY.md`](../build/BUILD-AND-DEPLOY.md)。

## 1. 环境

| 项 | 值 |
|---|---|
| JDK（构建） | `C:/Users/<user>/.jdks/jdk-21.0.12.1+1` |
| Node（运行/构建） | `C:/Users/<user>/scoop/persist/nvm/nodejs/v24.14.0` |
| pnpm | 10.33.2 |
| Gradle | 8.13（wrapper） |
| IntelliJ SDK | 2025.1（`IC`），compatible since 251 / until 263.* |
| 已安装插件 | `C:\Users\<user>\AppData\Roaming\JetBrains\IntelliJIdea2026.2\plugins\zcode-ide` |
| IDE 日志 | `C:\Users\<user>\AppData\Local\JetBrains\IntelliJIdea2026.2\log\idea.log` |

网络：GitHub git 走 `https://ghfast.top/https://github.com/...`；npm 用 `--registry=https://registry.npmmirror.com`；Gradle 插件走阿里云镜像（`plugins.gradle.org` DNS 不通）；JetBrains SDK 走 `cache-redirector.jetbrains.com`。

### 多仓库 Git 管理

本仓库与 `vendor/ZCode` 各自独立提交。IDE 的 Git 工具窗口默认只显示插件仓库；把 `$PROJECT_DIR$/vendor/ZCode` 注册为第二个 Git root 后即可同时管理。配置位置与提交后的联动步骤（`patch-budget` → 更新改动清单 → `bootstrap --update`）见 [`../../../vendor/README.md`](../../../vendor/README.md)。

## 2. 常用排查

```bash
grep -a "Starting ZCode server" "$LOCALAPPDATA/JetBrains/IntelliJIdea2026.2/log/idea.log" | tail -1
grep -a "zcode-server" "$LOCALAPPDATA/JetBrains/IntelliJIdea2026.2/log/idea.log" | tail -50
grep -a "FAIL\|Error" "$LOCALAPPDATA/JetBrains/IntelliJIdea2026.2/log/idea.log" | tail -30
```

- server 日志前缀 `[zcode-server]`，Logger 名 `ZCodeIDE`；远控桥日志前缀 `[zcode-remote]`。
- webview 控制台在 JCEF 里不可见；静默失败可在前端临时加 toast 定位（`workspaceActionError` 只 set 不渲染，catch 也是静默的）。
- JCEF 的 CDP 调试端口**可用**（2026-10-24 实测）：端口与路径写在 `%LOCALAPPDATA%\JetBrains\IntelliJIdea2026.2\jcef_cache\DevToolsActivePort`，`curl http://127.0.0.1:<port>/json/list` 能列出 ZCode 页面（URL 含 `token=`）及其 `webSocketDebuggerUrl`，可直接用 CDP 操作真实 UI，验证交互比注入 toast 更可靠。旧记录"2026.2 无效"指的是 registry 配置方式，不是这个端口文件。

### 2.1 node 进程盘点（"任务管理器一堆 node"先对这张表）

按命令行特征归类（PowerShell `Get-CimInstance Win32_Process`，看 `CommandLine` 与 `ParentProcessId`）：

| 特征 | 归属 | 说明 |
|---|---|---|
| `packages/server/dist/entry-http.js` | 本插件 server | 全 IDE 唯一，父进程是 `idea64.exe` |
| `packages/ide-remote-bridge/dist/index.mjs` | 本插件远控桥 | 父进程 `idea64.exe`；关掉远控就没有 |
| `zcode.cjs app-server --stdio`（父是 server） | 本插件 agent | **一个打开 ZCode 面板的项目一个**；官方模型不可跨项目复用（[`INVARIANTS.md`](./INVARIANTS.md) 第 23 条） |
| `__zcode-plugin-host` / `soundcraft.../server.mjs` / `@playwright/mcp/cli.js`（父是 agent） | agent 的插件宿主与 MCP | 2026-10-25 已全部停用（见 [`../changes/2026-10-25-3-ide-plugin-mcp-disabled.md`](../changes/2026-10-25-3-ide-plugin-mcp-disabled.md)）；当前基线 3 窗口 = 5 个 node |
| `ZCode.exe ... app-server --stdio --surface desktop` | 官方桌面客户端 | 不是本插件的；它的插件宿主随会话空闲回收 |
| `fusion-win-x64.exe` 下的 `@playwright/mcp` | JetBrains coding-copilot 插件 | 与本插件无关 |
| `~/.ezllm` 下的进程 | ezllm | 与本插件无关 |

排查"进程变多"的顺序：先数 agent 个数（每个打开面板的项目 1 个，**多出来的通常是同一项目的另一种路径写法**，查日志 `ZCode agent process started` 后面的 `workspaceKey`），再看 agent 子进程里有没有插件宿主（对照 `~/.zcode/cli/config.json` 的启用状态）。

## 3. 用 CDP 观测桥（比读代码、比加 toast 都可靠）

桥的两端都是全局函数，**在页面里各包一层就能记录整条链路的真实请求与回填**，因为 `invoke` 每次都从 `window.` 上取：

```js
// 记录下来：Web→IDE 发出去的请求 + Java 的回填结果
window.__calls = []; window.__res = [];
const q = window.__ZCODE_IDE_QUERY__, r = window.__zcodeIdeResolve;
window.__ZCODE_IDE_QUERY__ = (json) => { window.__calls.push(json); return q(json); };
window.__zcodeIdeResolve = (id, ok, payload) => { window.__res.push({ id, ok, payload }); return r(id, ok, payload); };
```

`{"ok":true,"p":"{\"success\":true}"}` 说明 Java 侧真的执行了；只有 `__calls` 没有 `__res` 说明面板/桥没接上。**注意重复执行会把包装叠起来**，同一次点击出现 2~4 条相同请求是叠加造成的，不是代码重复发。

验证「点文件」类行为不要只看 JS 侧：再用 `ide-capture.ps1` 截图确认 IDE 里真的出现了编辑器标签页，否则 `success:true` 也可能只是 VFS 命中但没导航。

### 3.1 刷新页面验证前端产物：别用 `location.reload()`

JCEF 里实测 `location.reload()` / `location.replace(url)` 可能不换 bundle（URL 甚至没有变化），CDP 读到的仍是旧 `<script src>`。验证前端改动时改用 CDP `Page.navigate`，并给 URL 追加一次性 query：

```js
// 直连 page 的 webSocketDebuggerUrl，发送：
{ method: "Page.navigate", params: { url: "<原 URL>&v=<timestamp>" } }
```

导航后再读 `[...document.scripts].map(s => s.src.split('/').pop())`，hash 与 `vendor/ZCode/packages/web-ide/dist/assets/` 一致才算换成功。构建产物、安装目录、JCEF 实际加载三方都可能不同步，判定基准始终是日志 `web=` + 页面里的真实 hash。

### 3.2 截图与临时脚本的两个坑

- 窗口最小化时 `GetWindowRect` 返回 `-16000,-16000`，`ide-capture.ps1` 只截到几百字节的空白图。先 `ShowWindow(hwnd, 9)` 恢复、`SetForegroundWindow` 置前，再截图。
- 临时 `.ps1` 用 ASCII 内容：PowerShell 5.1 按 ANSI 读取无 BOM 的 UTF-8，中文会触发"字符串缺少终止符"一类解析错误。仓库内已有的 `.ps1` 都是 UTF-8 with BOM，可直接用。

## 4. 在页面里"点"真实 UI

- 优先用 `Input.dispatchMouseEvent` 的完整序列（`mouseMoved` → `mousePressed` 带 `buttons:1` → 60ms → `mouseReleased`）。**只发 pressed/released 而不带 `buttons` 时，React 侧部分行/卡片收不到**，表现为"点了没反应"。
- 坐标用 `getBoundingClientRect()` 取中心点，先 `document.elementFromPoint(x,y)` 打印命中元素，避免点到浮层或相邻行。
- 仍点不动时，直接调 DOM 节点上的 React props 比模拟鼠标更稳：`const p = li[Object.keys(li).find(k=>k.startsWith('__reactProps'))]; p.onClick({type:'click', target:li, currentTarget:li, stopPropagation(){}, preventDefault(){}})`。任务列表行就是这么打开会话的。
- 命令行 `SendKeys` 发快捷键到 IDE 基本不可靠（被 IME/keymap 吞掉），不要依赖。

## 5. 重启后"什么都没有"先看工具窗口开没开

面板是**懒启动**：IDE 恢复布局时如果 ToolWindow 是关闭状态，`ZCodeService.url()` 不会被调用，日志里既没有 `Starting ZCode server`，CDP 的 `/json/list` 也没有 ZCode 页面。这不是插件坏了。点右侧 stripe 的 Z 图标（本机 1928×1048 窗口约在相对坐标 `(1915, 190)`；不确定就先裁剪 `x≈1840..1920` 放大看）打开面板，再等 10~15 秒。

另外 `stop-ide.ps1` 的优雅关闭在有未保存文档/弹窗时会超时，需要 `-Force`；强杀后 IDE 会丢失本次会话的窗口布局，下次启动可能只恢复一个项目窗口。
