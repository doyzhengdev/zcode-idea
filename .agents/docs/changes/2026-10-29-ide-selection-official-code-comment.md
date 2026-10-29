# 2026-10-29 · IDE 选区发送改走官方「代码评论加入对话」事件，SessionPane 补丁还原

- **范围**：`vendor/ZCode/packages/web-ide/src/ideContextPush.ts`（插件侧）；`vendor/ZCode/packages/ui/src/v4/SessionPane.tsx`（还原为上游原状）
- **触发**：用户报告选区发送会覆盖对话框草稿；用户裁决选区也切官方链路，并确认「尽量不改官方源码」为底线原则（已写入 AGENTS.md 红线 1）
- **提交**：working tree（未提交）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `packages/web-ide/src/ideContextPush.ts` | 修改（插件自有） | `insertSelectionRefs` 从 store 请求（`setText` 覆盖全文）改为派发官方 `zcode:code-comment-add-to-chat` 事件——与官方代码预览「选区评论加入对话」同链路；事件未被消费时回退既有 store 请求兜底 |
| `packages/ui/src/v4/SessionPane.tsx` | **还原为上游原状** | `externalTextInsertRequest` 恢复上游 `focused && sessionId === null` 门控（该补丁原为 IDE 推送放开活动会话消费；推送主路径已 100% 官方事件化，不再需要） |

**官方源码：净减少 1 个补丁文件，22 修改 / 预算 23（余 1）。**

## 为什么改

**根因**：选区链路此前走 store 插入请求（`prepend-if-missing` + `mention=undefined`），消费端兜底分支是 `setText(request.text)`——**替换整个输入框内容**，有草稿时草稿丢失。

**官方对应物**：官方桌面端代码预览的「选区写评论加入对话」走 `CODE_COMMENT_ADD_TO_CHAT_EVENT`（`zcode:code-comment-add-to-chat`），payload 原生携带 `{sourcePath, sourceTitle, selectedText, comment, startLine, endLine}`；composer 把它作为**上下文附件**挂在输入框上方（可单独删除），发送时官方自动序列化为 `# Code comments:` 块（File/Lines/Selected text/Comment）拼在正文后。**不碰输入框正文，零覆盖。**

**关键事实（实测+代码确认）**：`SessionPane` 的 `focused` 是 prop（分屏活跃面板语义，单面板缺省 `true`），不是输入框/系统焦点；`window.dispatchEvent` 是页面内部总线与系统焦点无关。因此单面板的 IDE 场景下官方事件**恒被消费**，原以为需要的「未聚焦兜底」实际不可达——`SessionPane` 补丁（为兜底消费服务）随之失去存在意义，安全还原。

**设计保持**：`selectedText`/`comment` 传空串，维持 2026-10-24「只发路径+行号、不发原文」的决策（模型按 File+Lines 自己读文件）；如需带原文只需在 `ideContextPush` 填 `selectedText`，仍零官方改动。

## 行为变化

- 选区发送：引用以「代码评论」上下文附件挂在输入框上方（显示「N 条评论」），**不再覆盖草稿**；发送后模型收到官方 code-comment 块（文件+行号）。
- 面板未打开/未聚焦等极端态：回退 store 请求（草稿态才消费，活动会话滞留）——主路径不依赖它。
- 桌面端与独立 web 端：`SessionPane` 恢复上游原状，官方行为分毫不差。
- 补丁预算：22/23，**余 1**。

## 验证

1. IDE 实机（CDP，新 bundle `index-Cs12R67A.js`，`web=` 指向源码 dist）：
   - 文件推送：chip 末尾追加（`README.md `）✓
   - 选区推送：正文保持不变 + composer 出现「1 条评论」附件 ✓
   - 多文件：顺序与选择一致（`README.md zcode.lock `）✓
   - 评论 chip 可通过「移除代码评论」按钮清除 ✓
2. `git diff 3c5b2276 -- SessionPane.tsx` = 0 行（上游原状）；`patch-budget --worktree` = 修改 22 / 预算 23。
3. 发送后的 `# Code comments:` 序列化由官方提交逻辑承担（`buildPromptWithCodeComments`），未实际发消息验证，属官方既有路径。

## 风险 / 后续

- 「未聚焦兜底」仅在多 pane 异态可达，且活动会话中滞留不消费——若未来观察到引用丢失，优先查这里。
- code-comment 附件的 comment 为空串时，发送块里 `Comment:` 段为空——模型侧表现待观察；需要时可改为自动填入引导语（插件侧一行）。
- `selectedText` 维持空串；若用户希望携带原文（对未保存修改更稳），在 `ideContextPush` 填入即可。
