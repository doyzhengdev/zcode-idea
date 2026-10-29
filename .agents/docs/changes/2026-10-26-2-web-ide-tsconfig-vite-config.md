# 2026-10-26 · 修复 web-ide 的 vite.config.ts 类型报错（TS2307 / TS1343）

- **范围**：`vendor/ZCode/packages/web-ide`（插件自有包，不计入官方补丁预算）
- **触发**：用户反馈编辑器在 `packages/web-ide/vite.config.ts` 上报
  `TS2307: Cannot find module @zcode/shared/zcodeEndpoint` 与
  `TS1343: The import.meta meta-property is only allowed when the --module option is ...`
- **提交**：working tree（`vendor/ZCode` 未提交）

## 源码改动

| 文件 | 类型 | 说明 |
|---|---|---|
| `vendor/ZCode/packages/web-ide/tsconfig.json` | 修改 | 改为 `extends ../../tsconfig.base.json`，只保留必要覆盖；`include` 补 `vite.config.ts` |
| `vendor/ZCode/packages/web-ide/src/idePlatform.ts` | 修改 | 三处回调参数补显式类型，仅类型标注 |

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,          // base 为 tsc -b 准备；本包不参与构建，否则依赖源码报 TS6307
    "lib": ["ES2025", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["node", "vite/client"],
    "paths": { "@/*": ["../ui/src/*"] },
    "strict": true,
    "noEmit": true
  },
  "include": ["src", "vite.config.ts"]
}
```

## 为什么改

`packages/web-ide/tsconfig.json` 是新加、只服务编辑器的配置：`vite build` 走 esbuild，
不读 `include`。但它当初只写了 `include: ["src", "tests"]`，导致两类问题：

1. **`vite.config.ts` 不属于任何 project**，编辑器对游离文件退回默认选项
   （`module: commonjs`、`moduleResolution: node10`）：
   - `node10` 不读 `package.json` 的 `exports`，`@zcode/shared/zcodeEndpoint` 这条子路径映射
     （`./zcodeEndpoint` → `./src/zcodeEndpoint.ts`）失效 → `TS2307`；
   - `module` 不是 `es2020`/`nodenext` 等值时 `import.meta` 不合法 → `TS1343`。
2. **`src/` 里的浏览器代码按"Node 环境"检查**：没有 DOM lib、没有 `jsx`、没有 `@/` 别名、
   没有 CSS 模块声明，`window`/`document`/JSX/`@/store/*` 全部报错。

修复后按仓库惯例改为继承 `tsconfig.base.json`（`module`/`moduleResolution: nodenext`、
`verbatimModuleSyntax`、`skipLibCheck`、`noUncheckedIndexedAccess` 等都来自 base），
只覆写 web-ide 特有的五项。覆盖 `composite: false` 是必需的：base 面向 `tsc -b` 的
composite 工程，要求列全所有文件，而 web-ide 通过 `@zcode/ui` 的 exports 引用 ui 源码，
不关掉会报 `TS6307`。

补齐 `src` 侧配置时暴露出 3 处真实遗漏：`platform` 对象字面量没有上下文类型（外层是
`as unknown as IPlatformService` 断言），这几个回调参数一直处于隐式 `any`，现补上
`@zcode/shared` 已导出的请求类型。

没有采用"单独建 `tsconfig.node.json`"的方案：这个 tsconfig 只租给编辑器，并进同一个 project
足够，少一个需要同步的文件。

## 行为变化

无运行时行为变化。`tsconfig.json` 不影响 `vite build` 产物；`idePlatform.ts` 只加类型标注。
A/B 构建验证了产物逐字节一致（见下）。

## 验证

1. 临时用 `{"extends":"./tsconfig.json","include":["vite.config.ts"]}` 单独检查该文件：0 错误，
   确认 nodenext 下 `@zcode/shared/zcodeEndpoint` 与 `import.meta` 都能解析。
2. `tsc -p packages/web-ide/tsconfig.json --noEmit`：`packages/web-ide/` 下的诊断从 34 条降到
   **0 条**（含 `vite.config.ts`）。`--showConfig` 确认模块为 `nodenext`、`jsx: react-jsx`、
   `strict`、`noEmit`，纳入文件 5 个（4 个 src + `vite.config.ts`）。
3. A/B 构建：还原改动时 `pnpm --filter @zcode/web-ide build` 得到
   `index-C1G5gK-J.js` 6,684,014 字节；精简前后再构建，产物文件名与字节数完全相同，
   `diffs.worker-*.js` 仍为 827,865 字节（前一次修复的回归项保持）。
4. 未在 IDE 编辑器里复验：需要重启 TS service 或重开文件才会刷新诊断。

## 风险 / 后续

- 继承 base 后不再检查 `noUnusedLocals` / `noImplicitOverride`（base 没有这两项，ui 也没有），
  与仓库其余包保持一致；`strict` 仍保留，web-ide 源码照旧按严格模式检查。
- 该 tsconfig 通过 `@zcode/ui` 的 exports 把 ui/shared 源码拉进 program，所以 `tsc -p` 仍会报出
  这些依赖包自身的既有错误（`ElectronWebviewTag` 未声明等）。编辑器按"就近 tsconfig"把这些文件
  归到各自包的 project，不受影响；若以后要把它当正式 typecheck 门槛，需要补 shims 与
  project references。
- `packages/web/tsconfig.json`（官方文件）同样是 `include: ["src"]`，`packages/web/vite.config.ts`
  存在同样的游离问题；它计入官方补丁预算，本次不动。
- 插件仓库暂存区里有一个 0 字节的 `scripts/publish-npm.mjs`（非本次改动，来源不明），
  本次未处理。

## 相关

- 同类改动：[2026-10-26 diffs worker 摇树](./2026-10-26-web-ide-diffs-worker-treeshake.md)
- 构建与部署：[`../build/BUILD-AND-DEPLOY.md`](../build/BUILD-AND-DEPLOY.md)
