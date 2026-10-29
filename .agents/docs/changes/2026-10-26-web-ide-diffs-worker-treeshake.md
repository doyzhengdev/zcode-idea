# 2026-10-26 · 修复 IDE 内 Markdown 代码块正文空白（diffs worker 被摇成 0B）

- **范围**：`vendor/ZCode/packages/web-ide` 构建配置
- **触发**：用户反馈对话里的代码块只显示 `text` 标题，正文（中文描述）看不到；会话数据本身完整
- **提交**：working tree（`vendor/ZCode` 未提交）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `vendor/ZCode/packages/web-ide/vite.config.ts` | 修改 | 新增 `worker.rollupOptions.treeshake = false`，与 `packages/web/vite.config.ts` 的既有规避保持一致 |

```ts
worker: {
  rollupOptions: {
    // @pierre/diffs 的 worker 入口依赖 import 后注册 message 监听。
    // 它的 package sideEffects 漏声明会让生产 worker 子构建被摇成 0B；
    // 只关闭 worker 构建的摇树，避免影响主包。
    treeshake: false,
  },
},
```

## 为什么改

`@pierre/diffs` 1.1.22 的 `package.json` 只把 `dist/components/web-components.js` 声明为
`sideEffects`，而 `dist/worker/worker.js` 是纯副作用入口（import 后注册 `message` 监听）。
`packages/ui/src/workers/diffs.worker.ts` 只有一句 `import "@pierre/diffs/worker/worker.js"`，
web-ide 的 Vite worker 子构建把它整体摇树掉，产出 0 字节的
`assets/diffs.worker-*.js`。Worker 能创建但不注册监听，`WorkerPoolManager.initialize()`
永远等不到回包，`getPlainFileAST()` 一直返回 undefined，所有 Markdown 代码块保持空白。

`packages/web/vite.config.ts` 早已用同一段配置规避此问题；`packages/web-ide` 是插件自有包，
之前漏了这段，导致只有 IDE 内嵌页面受影响。该文件不计入官方补丁预算。

## 行为变化

修复后 IDE 对话里的 Markdown 代码块（含无语言标记的 `text` 块）正常显示正文；
不影响桌面端与独立 web 端（它们走 `packages/web` 的既有配置）。

## 验证

1. 修复前：`dist/web/assets/diffs.worker-lfVwyznw.js` 为 **0 字节**；浏览器复现时 Worker 收到
   `initialize` 但从未回包，`@pierre/diffs` 的 `<pre>` 为空。
2. 修复后：`pnpm --filter @zcode/web-ide build` 产出
   `dist/assets/diffs.worker-CAavpt0L.js`（**827,865 字节**），`index-CdEbTjpN.js`（6,684,026 字节）。
3. `node scripts/build-runtime.mjs` 重新组装 `dist/`，`dist/web/assets/` 中 worker 为 827,865 字节。
4. `./gradlew buildPlugin -PbundleRuntime=true`（JDK 21）成功，完整包 51,490,265 字节；
   `unzip -l` 确认包含 `runtime/web/assets/diffs.worker-CAavpt0L.js`（827,865 字节）。
5. 用临时静态服务器在 Chromium 里直接创建该 worker 并发送 `initialize`：
   收到 `{type:"success", requestType:"initialize"}`，`shiki-wasm` 引擎初始化正常。
6. **未部署/未重启 IDE**，因此尚未在真实面板里验证代码块恢复；当前运行中的面板仍加载旧 runtime。

## 风险 / 后续

- 本机已安装插件使用 `~/.zcode/ide/runtime/0.1.0-b177da31c187`（旧的 0B worker），只替换薄插件
  不会更新它；需安装本次完整包（`-PbundleRuntime=true`），或更新已安装 runtime 后再重启 IDE。
- `vendor/ZCode` 的改动尚未提交；提交后按流程跑 `node scripts/bootstrap.mjs --update`
  更新 `vendor/zcode.lock`，避免 `BUILD-INFO.json` 长期带 `dirty: true`。
- 上游若在 `@pierre/diffs` 补全 `sideEffects` 或改掉 worker 入口，本规避可以移除。

## 相关

- 构建与部署：[`../build/BUILD-AND-DEPLOY.md`](../build/BUILD-AND-DEPLOY.md)
- 运行时分发：[`../build/RUNTIME-DISTRIBUTION.md`](../build/RUNTIME-DISTRIBUTION.md)
- 同类既有配置：`vendor/ZCode/packages/web/vite.config.ts`
