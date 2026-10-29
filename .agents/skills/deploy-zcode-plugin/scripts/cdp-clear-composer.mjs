// 清空 ZCode 输入框（Lexical contenteditable）。
//
// 为什么不直接用 JS：输入框是 Lexical 编辑器，document.execCommand('selectAll'/'delete')
// 不会同步到它的内部状态；必须发真实键盘事件。这里走 CDP Input.dispatchKeyEvent，
// 等价于用户按 Ctrl+A、Backspace。
//
// 用法：
//   node cdp-clear-composer.mjs
//
// 输出：清理后的 innerText（正常应为空串或单个换行）。

import fs from "node:fs";
import path from "node:path";

function readDevToolsPort() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is not set");
  const jetbrains = path.join(localAppData, "JetBrains");
  const candidates = fs.existsSync(jetbrains)
    ? fs.readdirSync(jetbrains).filter((name) => name.startsWith("IntelliJIdea"))
    : [];
  for (const name of candidates.sort().reverse()) {
    const file = path.join(jetbrains, name, "jcef_cache", "DevToolsActivePort");
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, "utf8").split(/\r?\n/)[0].trim();
    }
  }
  throw new Error("DevToolsActivePort not found; the ZCode tool window may not be open yet");
}

const port = readDevToolsPort();
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(
  (item) => item.type === "page" && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url) && item.url.includes("token="),
);
if (!target) {
  console.error("no ZCode page target; open the ZCode tool window first");
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let seq = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const call = pending.get(message.id);
  if (call) {
    pending.delete(message.id);
    call(message);
  }
});

function send(method, params) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
  });
}

const selector = '[contenteditable="true"]';

const found = await send("Runtime.evaluate", {
  expression: `Boolean(document.querySelector('${selector}'))`,
  returnByValue: true,
});
if (found.result?.result?.value !== true) {
  console.error("composer not found on the page");
  ws.close();
  process.exit(2);
}

await send("Runtime.evaluate", {
  expression: `document.querySelector('${selector}')?.focus()`,
  userGesture: true,
});

const key = (type, keyName, code, keyCode, modifiers) =>
  send("Input.dispatchKeyEvent", {
    type,
    modifiers: modifiers ?? 0,
    key: keyName,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });

await key("keyDown", "a", "KeyA", 65, 2);
await key("keyUp", "a", "KeyA", 65, 2);
await new Promise((resolve) => setTimeout(resolve, 300));
await key("keyDown", "Backspace", "Backspace", 8);
await key("keyUp", "Backspace", "Backspace", 8);
await new Promise((resolve) => setTimeout(resolve, 500));

const result = await send("Runtime.evaluate", {
  expression: `JSON.stringify({ text: String(document.querySelector('${selector}')?.innerText || '') })`,
  returnByValue: true,
});
console.log(result.result?.result?.value ?? JSON.stringify(result));
ws.close();
