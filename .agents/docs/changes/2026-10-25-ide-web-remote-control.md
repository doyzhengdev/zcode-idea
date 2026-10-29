# 2026-10-25 · IDE 插件 Web 远控：复用官方 relay device 桥

- **范围**：`vendor/ZCode`（新增包 + web-ide）、插件 Kotlin、`scripts/build-runtime.mjs`
- **触发**：用户需求 —— 不安装官方 App，手机浏览器直接打开官方 `https://zcode.z.ai/remote/v4?sid=…&mid=…&name=…&app_version=…` 控制 IDE 里的 ZCode 会话
- **提交**：vendor fork `b177da31`（ide-integration）+ 插件仓库同批提交

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `vendor/ZCode/packages/ide-remote-bridge/package.json` | 新增 | 插件自有包；`build` 调 `scripts/build.mjs` |
| `vendor/ZCode/packages/ide-remote-bridge/src/index.ts` | 新增 | 桥入口；stdout 只输出一行 `{"type":"ready",...}`，日志走 stderr |
| `vendor/ZCode/packages/ide-remote-bridge/src/device.ts` | 新增 | 复用桌面 `WebRemoteControlDeviceTransport`；补 bootstrap/workspace-list/bridge-open，并把 `rpc-frame` 双向转发到本地 server `/ws` |
| `vendor/ZCode/packages/ide-remote-bridge/src/server-link.ts` | 新增 | `ws` + `SocketProtocol` 连本地 server `/ws`（terminal-client） |
| `vendor/ZCode/packages/ide-remote-bridge/src/credentials.ts` | 新增 | 读 `~/.zcode/v2/credentials.json` 的 `zcodejwttoken`（纯 Node 解密，无 Electron） |
| `vendor/ZCode/packages/ide-remote-bridge/src/telemetry-shim.ts` | 新增 | 替代 desktop transport 的遥测 import，官方文件零改动 |
| `vendor/ZCode/packages/ide-remote-bridge/src/terminal-probe.ts` | 新增 | 模拟手机 terminal 的端到端自检（bootstrap + bridge + 真实 RPC 调用） |
| `vendor/ZCode/packages/ide-remote-bridge/scripts/build.mjs` | 新增 | esbuild 单文件 ESM；注入 `createRequire` 兼容 bundle 内的 CJS 依赖 |
| `vendor/ZCode/packages/web-ide/src/idePlatform.ts` | 修改 | 把 4 个远控占位从"不支持"改为调用 IDE 桥 |
| `src/main/kotlin/dev/zcode/ide/remote/RemoteControlBridge.kt` | 新增 | 应用级桥进程生命周期：启动、解析 ready、日志、停止 |
| `src/main/kotlin/dev/zcode/ide/bridge/IdeBridge.kt` | 修改 | 新增 `startWebRemoteControl` / `stopWebRemoteControl` / `getWebRemoteControlStatus` |
| `src/main/kotlin/dev/zcode/ide/runtime/RuntimeLayout.kt` | 修改 | 新增 `remoteBridgeEntry`（仓库/打包两种布局） |
| `src/main/kotlin/dev/zcode/ide/runtime/ServerProcess.kt` | 修改 | 暴露 `authToken()` 给插件自有进程 |
| `src/main/kotlin/dev/zcode/ide/service/ZCodeServerManager.kt` | 修改 | 新增 `connection()`（baseUrl + token） |
| `scripts/build-runtime.mjs` | 修改 | 要求并拷贝 `packages/ide-remote-bridge/dist/index.mjs` → `runtime/remote-bridge/index.mjs` |
| `scripts/ci-build.mjs` | 修改 | CI 增加 `pnpm --filter @zcode/ide-remote-bridge build`：桥不在 cli/server/web-ide 任一构建目标的依赖闭包里，漏掉这步 build-runtime 的 `must()` 必失败（2026-10-25 复审时补上） |
| `vendor/ZCode/pnpm-lock.yaml` | 修改 | importers 补 `packages/ide-remote-bridge: {}`（无依赖空条目；pnpm 10.33 frozen 可自动补齐，落库以免各机漂移；不计补丁预算） |

## 为什么改

官方手机远控的链路是"手机 Web → 厂商云 relay → Electron main → 窗口 Host"。插件没有 Electron main，
但有官方 server 的 `/ws`；而 relay 只透传 `rpc-frame`（不解析业务），所以不需要复刻 Window Host：

- relay 连接、注册、V2 心跳/重连：直接复用 `packages/desktop/src/main/web-remote-relay/` 的
  `WebRemoteControlDeviceTransport` 与 `createWebRemoteControlV2Http`；
- 分片/ACK/流控：直接复用 `packages/client` 的 `createAcknowledgedWebRemoteControlRelayProtocol`；
- 插件新增的只有：bootstrap/workspace-list/bridge-open 三个业务消息，以及
  `IMessagePassingProtocol` ↔ 本地 `/ws` 的双向帧转发。

被否决的方案：

1. 自建直连（手机访问局域网 server）：需要额外前端与穿透，且拿不到官方手机页体验。
2. 复刻整个 `webRemoteControlManager`：与 Electron `MessageChannelMain` / Window Host 强绑定，成本高且无必要。
3. 修改官方 transport 去掉遥测：改为构建期 alias 替换，官方文件零改动。

## 行为变化

- **插件使用独立设备身份**（最终决策）：
  - `deviceMid`：`zcode.ide.remote.deviceMid`（IDE 级持久化，`ide-<uuid>`）；
  - `deviceSid`：`~/.zcode/v2/ide-remote-device.json`，首次注册后长期复用；
  - 设备名：`<hostname> (IDE)`，手机端会同时看到 `<host>`（桌面）和 `<host> (IDE)`，
    可以直接区分哪个端在线；
  - 两端可以同时开启远控，不会互相踢下线；
  - 不读写桌面的 `setting.json` / `telemetry-state.json`，两边状态完全隔离。
- **一个桥进程，支持 ZCode 全部项目**：`RemoteControlBridge` 是应用级单例，全 IDE 只有一个 Node 桥；
  桥通过本地 server 的 `projectService.readTree()` 读取 ZCode 里添加的所有项目（与桌面客户端共用
  `~/.zcode` 数据），手机端可以浏览并切换这些项目。多窗口不会各起一个桥；项目列表不变时任意窗口
  重复点击远控都复用同一个进程。
- **默认选中当前窗口项目**：`initialViewState.activeWorkspaceKey` 使用发起远控的 IDE 项目；手机端
  之后自己的选择由 `mobileViewState` 保持。
- **workspaceKey 宽容匹配**：手机端点击对话时可能用任务里的路径（`E:\work\zcode-ide` 或
  `E:/work/zcode-ide`）而不是 `workspaceIdentity` 发起 `workspace-bridge-open`。桥同时接受
  identity、正斜杠路径、反斜杠路径，统一转小写并去尾斜杠后比较。
  > **后续修正**：最初"回给手机的 key 保持请求原值"会让同一项目在 server 侧变成两个
  > workspaceKey、各起一套 agent。现已改为一律回写 server 原始写法，也不再给 local 目标下发
  > `workspaceIdentity`，详见
  > [2026-10-25-2-ide-remote-workspace-key-dedup.md](./2026-10-25-2-ide-remote-workspace-key-dedup.md)。
- **IDE 启动后自动恢复上次远控**：桥启动成功时把目标写入
  `zcode.ide.remote.lastEnabled`（`workspacePath` + 可选 `workspaceIdentity`）；IDE 启动后延迟
  8 秒自动恢复，恢复前会确保共享 server 已启动（用户没打开 ZCode 面板也会主动拉起）。启动失败
  每 10 秒重试，最多 6 次。
- **用户显式停止才清除意图**：`stopWebRemoteControl` 会清除 `lastEnabled`，下次 IDE 启动不再
  自动恢复；IDE 退出、切换 workspace、启动失败等内部停止都保留意图。
- **链接长期有效**：设备注册一次后持久化，停止/重启 IDE、重新开启远控都复用同一个 `sid`
  （实测 stop → start 前后 `sid` 不变）。
- 手机浏览器打开后按官方流程登录同一 ZCode 账号即可看到当前 IDE 项目的任务列表、打开会话、发送输入。
- 停止远控或 IDE 退出时桥进程整体退出；同一 workspace 重复启动复用已有进程。

> 曾实现过"复用桌面 `deviceMid`/`deviceSid`、链接与桌面完全一致"的方案，但同一设备同一时刻只能
> 一个端在线：桌面客户端的自动恢复会持续占用 `sid`，IDE 连接会被 relay `KICKED`。最终按"可区分端、
> 可同时在线"的目标拆成两个独立设备。

## 验证

已执行：

1. `pnpm --filter @zcode/web-ide build` 通过。
2. `node packages/ide-remote-bridge/scripts/build.mjs` 产出 `dist/index.mjs`。
3. `node scripts/build-runtime.mjs` 把桥拷入 `dist/remote-bridge/index.mjs`。
4. `JAVA_HOME=…jdk-21 ./gradlew buildPlugin` 通过；zip 内含 `runtime/remote-bridge/index.mjs`。
5. 协议端到端（自动化，**非真机**）：本地起 `packages/server/dist/entry-http.js`，桥以 device 角色注册并连
   `wss://zcode.z.ai/api/v1/remote/ws2`，`terminal-probe` 以 terminal 角色配对后：
   - `bootstrap-response` / `workspace-list-response` 正常；
   - `workspace-bridge-ready` 正常；
   - 通过 forwarded `rpc-frame` 调用 `settingService.get()` 返回真实设置。
   上述在"仓库布局产物"和"`dist/remote-bridge` 打包产物"上各跑通一次。
6. IDE 实机（重启后 CDP 调用桥方法）：
   - 返回链接为 `sid=d_Rdk5BTVAUPW3tNSxAwakLr&mid=ide-7aaae8e0-…&name=<host> (IDE)&app_version=3.16.2`；
   - relay 在线列表同时出现 `<host>`（桌面，3.16.3）与 `<host> (IDE)`（插件，3.16.2），两端互不影响；
   - `stopWebRemoteControl` → `startWebRemoteControl` 后 `sid` 与会话 id 完全不变。
7. IDE 侧多项目：桥的 `bootstrap-response` 返回了 ZCode 里 16 个项目
   （`ZCode`、`zcode-ide`、`jzj-medical`、`<your-bucket>`、`uni-utils`、…、`agents`），
   `initialViewState` 默认选中当前窗口的 `E:/work/zcode-ide`；随后 `workspace-bridge-ready`
   与 forwarded RPC 均正常。多窗口复用同一个桥进程，不按窗口各起一个。
8. 自动恢复：
   - 手动开启一次后 `other.xml` 出现 `zcode.ide.remote.lastEnabled`；
   - 重启 IDE 后日志出现 `Auto-restored ZCode remote bridge`，`sid` 与上次一致；
   - 调用 `stopWebRemoteControl` 后重启，`lastEnabled` 已被移除，日志不再出现自动恢复，
     也没有新的桥进程。
9. workspaceKey 兼容：`terminal-probe` 用 `PROBE_WORKSPACE_KEY='E:\work\zcode-ide'`
   （反斜杠路径）发起 `workspace-bridge-open`，返回 `bridge ready` 且 forwarded RPC 正常，
   不再报“未知工作区”。

未验证：

- 手机端在两个设备之间切换、扫码后进入 IDE 远控的完整 UI（任务列表、会话流、发消息）；
- `platform-request`（附件/MCP 目录）目前返回"暂不支持"；
- 多项目切换（桥当前只登记启动时的单个 workspace）。

## 风险 / 后续

- **自动恢复会主动启动 server**：即使用户没打开 ZCode 面板，恢复流程也会拉起共享 server，
  因此 IDE 启动后会有 Node server 进程常驻；不想要远控时点一次“停止远控”即可。
- **项目列表范围**：手机端列出的是 ZCode 项目库里所有未删除项目（`includeDeleted: false`），
  不只是 IDE 当前打开的项目；项目列表有 5 秒缓存，ZCode 里新增项目后手机端刷新即可看到。
- **两条链接**：桌面一条、IDE 一条，需要用户分别保存；手机端设备列表会出现两个同名机器（靠 `(IDE)` 区分）。
- **账号前提**：桥从 `~/.zcode/v2/credentials.json` 读 `zcodejwttoken`；用户未登录 ZCode 账号时启动会报错。
- **协议依赖**：`/remote/v4` 是官方 OSS 页面与私有 relay 协议，上游改变配对/版本协商会直接影响本功能。
- **并发**：手机与 IDE 面板同时连同一 task 都是 `web-remote-replayable`，同一 Agent 的并发输入语义需真机复测。
- **能力边界**：手机端拿不到 IDE 专属的 `platform` 能力（文件选择等），需要后续按需映射到 JCEF 桥。
- **安全**：device 注册使用用户账号 JWT，但不把 JWT/token 放进二维码；二维码只含 `sid/mid/name/app_version`。

## 相关

- 官方实现参考：`vendor/ZCode/docs/web-remote-control/web-remote-control-architecture.md`
- 插件文档：[`PROJECT-MAP.md`](../architecture/PROJECT-MAP.md)、[`IDE-VS-DESKTOP.md`](../architecture/IDE-VS-DESKTOP.md)
