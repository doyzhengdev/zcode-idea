# ZCode IDE (JetBrains plugin)

[![npm version](https://img.shields.io/npm/v/zcode-idea?style=flat-square&logo=npm)](https://www.npmjs.com/package/zcode-idea)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](./LICENSE)
[![JetBrains](https://img.shields.io/badge/JetBrains-2025.1%2B-black?style=flat-square&logo=jetbrains)](https://www.jetbrains.com/)

![ZCode inside the IntelliJ IDEA side panel](./docs/images/panel.png)

Use **official ZCode** right inside a JetBrains IDE side panel: the UI is the official web UI,
the backend is the official `@zcode/server`, and the plugin only supplies local Node plus the
IDE's built-in browser engine (JCEF). **No Electron.**

Same UI, same agent, same `~/.zcode` data directory — not a ZCode look-alike, but the official
product with the IDE as its shell.

```bash
npx zcode-idea@latest update
```

One command discovers your IDEs, compares versions, closes and replaces the plugin directory,
then restarts the IDE.

## Why a plugin at all

The official ZCode client is a separate app: it does not know which project you have open in your
IDE or which code you selected. The plugin puts the agent where the code is:

- **Official code, reused as-is** — UI, sessions and agent behaviour all come from upstream;
  the plugin touches ~0.04% of upstream lines (19 files).
- **The project is the context** — the panel is bound to the current project; right-click a
  file or directory, or send the editor selection, straight into the conversation.
- **The IDE is the shell** — windows, tray, notifications, updates and shortcuts are handled by
  the IDE instead of a bundled Electron shell.

## Features

| Area | What you get |
|---|---|
| Chat & tasks | Official chat UI, streaming replies, project/session list, model & thinking level, drafts |
| IDE integration | Open files at a line/column, reveal directories in the project tree, send file references and selections (`path#Lx-Ly`) |
| Host capabilities | File/folder dialogs, save-as, external links, notifications, MCP directory, memory details |
| Runtime | One shared server per IDE, fixed port + persisted token, Node 24 auto-provisioning, full package with bundled runtime |
| Remote | QR code in the panel; control this IDE project from a phone browser |

The panel stays usable while the IDE is indexing. Sessions are shared with the desktop client
(same `~/.zcode`) — but **do not run both at once** (SQLite lock).

## Not supported

Remote workspaces / remote attach, Docker, WSL / SSH, Computer Use, and the embedded browser
side panel are not available in the IDE form. Desktop-shell features (window controls, tray,
app menu, clipboard/power, in-app auto-update, cross-window tab sync, window screenshots) are
handled by the IDE itself.

A few desktop-only entry points are hidden in the IDE form (new project, project groups and
search, plugin marketplace, built-in terminal, right side panel); the IDE offers equivalent
workflows.

## Requirements

| Item | Requirement |
|---|---|
| IDE | IntelliJ Platform 2025.1+ (`since-build 251`, `until-build 263.*`), JCEF required |
| Runtime | Node ≥ 24 (system Node preferred, otherwise downloaded to `~/.zcode/ide/runtime-node`) |
| Products | IntelliJ IDEA, WebStorm, PyCharm, GoLand, CLion, DataGrip, RubyMine, PhpStorm, … |

## Building

Requires JDK 21, Node ≥ 24, pnpm 10. **Windows only** (native dependencies).

```bash
node scripts/bootstrap.mjs                                  # prepare vendor/ZCode at the locked commit
JAVA_HOME=/path/to/jdk-21 ./gradlew buildPlugin             # thin package (runtime downloaded on demand)
JAVA_HOME=/path/to/jdk-21 ./gradlew buildPlugin -PbundleRuntime=true   # full package with runtime
```

After changing frontend or upstream sources under `vendor/ZCode`:

```bash
cd vendor/ZCode && pnpm --filter @zcode/web-ide build
cd ../.. && node scripts/build-runtime.mjs
JAVA_HOME=/path/to/jdk-21 ./gradlew buildPlugin
```

Architecture, bridge contract and deployment details live in [`.agents/docs/`](./.agents/docs/README.md).

## Links

- Upstream ZCode source: https://github.com/zai-org/ZCode
- Our ZCode fork (patches on `ide-integration`): https://github.com/doyzhengdev/ZCode
- ZCode product page: https://zcode.z.ai

## Notice

Community plugin, not affiliated with Z.ai. ZCode is a product of Z.ai.
