# 2026-10-28 · IDE 右键发送文件引用改走官方「加入对话」事件（零官方补丁）

- **范围**：`vendor/ZCode/packages/web-ide/src/ideContextPush.ts`（插件侧）；AGENTS.md（原则表述强化）
- **触发**：用户 bug 报告（引用插到输入框开头而非光标位置、看到「文件名(文件名)」格式）+ 用户裁决：**尽量不改官方源码是底线原则，优先级高于任何需求**
- **提交**：working tree（未提交）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/web-ide/src/ideContextPush.ts` | 修改（插件自有） | `filesToInput` 不再调 store 的 `requestComposerTextInsert`，改为派发官方 `WORKSPACE_FILE_ADD_TO_CHAT_EVENT`（`zcode:add-workspace-file-to-chat`）——与官方桌面端文件树右键「加入对话」/拖拽完全同一条链路；事件未被消费（面板未聚焦）时回退 store 请求（官方既有 `prepend-if-missing` 模式），避免静默丢消息 |
| `AGENTS.md` | 修改 | 红线第 1 条强化为「尽量不改官方源码——底线原则，优先级高于任何需求；功能与补丁面冲突时宁可调整功能方案也不新增官方补丁」 |

**官方源码：零改动。** 过程中曾实现的 insert-at-cursor 补丁（`ConversationComposer.tsx` + store 两处类型，+3 预算）已全部还原，`vendor/zcode.lock` 回到 `maxModified: 23`。

## 为什么改

**根因**：IDE 右键发送是我们自建链路（Java `__zcodeIdeMessage` → `ideContextPush.ts`），此前选了 store 插入请求协议的 `prepend-if-missing` 模式——该协议为「预填草稿」设计，只有 `replace` / `prepend-if-missing` 两种模式，前者覆盖草稿、后者固定插到第一段开头，都没有「末尾追加 / 光标处插入」语义。官方桌面端自己的文件树右键走的是组件内事件 + `inputApiRef` 直调 `appendFileMention`（末尾追加），不经 store 协议，所以官方无此问题。

**方案取舍**：曾实现 `insert-at-cursor` 新模式（改 3 个官方文件）并在 IDE 实机验证通过（chip 落在光标处）。用户裁决底线原则后废弃——改为复用官方现成的全局事件通道：`ideContextPush` 构造官方 `WorkspaceFileDragPayload`（含归一化 relativePath）派发事件，composer 按官方逻辑末尾追加。**插件侧行为与官方桌面端文件树右键完全一致，官方源码零改动。**

**兜底设计**：官方 composer 只在面板聚焦时监听该事件（`SessionPane` 传 `listenAddToChatEvents={focused}`），IDE 推送时面板可能未聚焦。`window.dispatchEvent` 返回 false 表示无人调用 `preventDefault`（即未被消费），此时回退 store 请求（`prepend-if-missing`，插到开头）——宁可位置不理想也不静默丢消息。

## 行为变化

- 面板聚焦时：IDE 右键发送的文件引用**追加到输入框末尾**（自动分隔空格、拉焦点），与官方桌面端文件树右键/拖拽行为一致；不再插到开头。
- 面板未聚焦时：回退为官方预填模式（插到开头），行为退化为 10-24 初始版，但不丢消息。
- 多文件：按选择顺序逐个追加（append 语义顺序天然保持，不再需要倒序）。
- 桌面端与独立 web 端：零变化（本就加载同一份官方代码，无官方改动）。

## 验证

1. 浏览器（本地测试 server + Playwright）：验证过 insert-at-cursor 方案（已废弃）与基线行为；chip markdown 载体 `[名](./相对路径)`、重复去重、草稿恢复均正常。
2. IDE 实机（insert-at-cursor 方案，已废弃）：CDP 验证 chip 落在光标处、失焦推送落在上次光标位置——证明对根因的判断正确。
3. 官方事件链路（最终方案）：`pnpm --filter @zcode/web-ide build` 通过；IDE 重启后 `web=` 指向源码 dist。CDP 实测：聚焦推送追加末尾 ✓、未聚焦回退 prepend（见变更记录更新）、多文件顺序保持。
4. `node scripts/patch-budget.mjs --worktree` = 修改 23 / 预算 23（余 3）；`check-change-log.mjs` 通过。

## 风险 / 后续

- 面板未聚焦时引用插到开头（官方预填模式兜底），与聚焦时的末尾追加不一致；实测未聚焦场景的实际表现后决定是否需要插件侧改进（如聚焦延迟重试）。
- 「文件名(文件名)」未定位到确切渲染点：官方事件链路的 canonical 载体仍是 `[名](./相对路径)`（根目录文件即 `[名](./名)` 字面形态），chip 建立正常；若复现需截图与操作步骤。
- 编辑器选区右键（`selectionToInput`）仍是 store 请求 + `setText` 替换全文语义，有草稿时会被覆盖；待确认预期后单独修。
