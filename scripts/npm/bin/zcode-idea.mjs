#!/usr/bin/env node
/**
 * zcode-idea：从七牛 CDN 获取插件包并安装到本机 JetBrains IDE。
 *
 * 主流程：
 * 1. 获取插件来源：远端 manifest（Ed25519 验签）或 --zip 本地包
 * 2. 发现 IDE（配置目录优先；安装目录需通过写探针）
 * 3. 选择目标（--all / --target 可跳过）
 * 4. 对比已安装版本（可更新 / 已是最新 / 拒绝降级；--force 覆盖）
 * 5. 关闭所选 IDE（仅需要安装的目标）
 * 6. 下载（缓存 + sha256 校验）→ 删旧目录 → 解压
 * 7. 汇总并启动 IDE（--no-launch 可跳过）
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import cac from "cac";
import {
  ensurePluginArchive,
  getCachedArchivePath,
  isCachePresent,
  prunePluginCache,
} from "../lib/download.mjs";
import { InstallError, UsageError } from "../lib/errors.mjs";
import { readInstalledPlugin } from "../lib/installed.mjs";
import { findLaunchCommand, launchDetached } from "../lib/launch.mjs";
import { error, formatBytes, info, isInteractive, warn } from "../lib/log.mjs";
import { validatePluginZip } from "../lib/manifest.mjs";
import { closeSelectedProcesses, isDirectoryLockedError, killPluginDirHolders } from "../lib/processes.mjs";
import { confirmClose, selectTargets } from "../lib/prompt.mjs";
import {
  comparePluginVersions,
  fetchManifestBundle,
  resolvePluginSource,
} from "../lib/remote.mjs";
import { discoverTargetsDetailed, formatTarget, makeExplicitTarget, parseTargetArgs } from "../lib/targets.mjs";
import { PLUGIN_DIR_NAME, extractPluginZip } from "../lib/unzip.mjs";

const pkg = JSON.parse(await fsp.readFile(new URL("../package.json", import.meta.url), "utf8"));

function buildCli() {
  const cli = cac("zcode-idea");
  cli.usage(
    "[update] [--all] [--dry-run] [--check] [--yes] [--force] [--no-launch] " +
      "[--source <url>] [--zip <path>] [--allow-http] [--target <dir>] [--timeout <秒>] " +
      "[--clean-cache]",
  );
  cli
    .option("--all", "安装到全部发现的 IDE（跳过交互选择）")
    .option("--dry-run", "获取 manifest 并打印版本对比与计划；不下载、不关 IDE、不解压、不启动")
    .option("--check", "只打印版本对比表后退出（不下载、不关 IDE、不安装）")
    .option("--yes", "跳过关闭 IDE 前的确认")
    .option("--force", "已是最新或远端版本更低时也强制安装")
    .option("--no-launch", "安装完成后不启动 IDE（默认会启动）")
    .option("--source <url>", "插件分发根 URL（安装器会追加 <npm包版本>/manifest.json）")
    .option("--zip <path>", "离线：直接使用本地插件 zip，跳过远端 manifest 与下载")
    .option("--allow-http", "允许非默认的 HTTP 插件源（仅测试域名联调）")
    .option("--target <dir>", "直接指定 plugins 目录（可重复或逗号分隔），跳过发现与选择")
    .option("--timeout <秒>", "等待 IDE 退出的秒数", { default: 30 })
    .option("--clean-cache", "安装结束后清理其它版本的插件包缓存（保留本次使用的版本）");

  // cac 会为 --no-* 自动补 default: true，帮助里显示成“(default: true)”容易被误解。
  // 这里只清掉帮助展示用的默认值：不传 --no-launch 时 launch 仍是 undefined（会启动），
  // 传了则由 mri 置为 false，语义不变。
  const noLaunchOption = cli.globalCommand?.options?.find(
    (option) => option.rawName === "--no-launch",
  );
  if (noLaunchOption?.config) noLaunchOption.config.default = undefined;

  cli.help();
  cli.version(pkg.version);
  cli.example("npx zcode-idea");
  cli.example("npx zcode-idea@latest update      # = --all --yes --force");
  cli.example("npx zcode-idea --check --all");
  cli.example("npx zcode-idea --all --yes");
  cli.example("npx zcode-idea --zip ./build/distributions/zcode-ide-0.1.0.zip --all --no-launch");
  return cli;
}

function targetLabel(target) {
  return `${target.productName}${target.version ? ` ${target.version}` : ""}`;
}

function statusLabel(row, force) {
  if (row.status === "missing") return force ? "强制安装" : "将安装";
  if (row.status === "update") return force ? "强制更新" : "可更新";
  if (row.status === "latest") return force ? "强制重装" : "已是最新（跳过）";
  return force ? "强制降级安装" : "跳过（远端版本更低）";
}

async function main() {
  const cli = buildCli();
  const parsed = cli.parse(process.argv, { run: false });
  if (cli.options.help || cli.options.version) return 0;

  // 位置参数只有一个可用命令：update = --all --yes --force（刷新到最新版）。
  // 安装器按自身 npm 版本读 <version>/manifest.json，所以推荐写成
  // `npx zcode-idea@latest update`，确保拿到的是与最新插件同版本的安装器。
  const command = parsed.args[0];
  if (command !== undefined && command !== "update") {
    throw new UsageError(`未知命令：${command}。支持的命令只有 update（等价于 --all --yes --force）。`);
  }
  if (command === "update" && parsed.args.length > 1) {
    throw new UsageError(`update 不接受额外参数：${parsed.args.slice(1).join(" ")}`);
  }
  const updateCommand = command === "update";

  const options = cli.options;
  const dryRun = Boolean(options.dryRun);
  const checkOnly = Boolean(options.check);
  const force = Boolean(options.force) || updateCommand;
  const allowHttp = Boolean(options.allowHttp);
  const assumeYes = Boolean(options.yes) || updateCommand;
  const installAll = Boolean(options.all) || updateCommand;
  const noLaunch = options.launch === false;
  const cleanCache = Boolean(options.cleanCache);
  const timeoutSec = Number(options.timeout ?? 30);
  const interactive = isInteractive();

  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 600) {
    throw new UsageError("--timeout 必须是 1–600 之间的秒数。");
  }

  const explicitPaths = parseTargetArgs(options.target);
  if (!interactive && !installAll && explicitPaths.length === 0) {
    throw new UsageError(
      "非交互终端：请用 --all 安装到全部发现的 IDE，" +
        "或用 --target <plugins 目录> 指定目标。",
    );
  }
  for (const targetPath of explicitPaths) {
    if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) {
      throw new UsageError(`--target 指向的不是目录：${targetPath}`);
    }
  }

  const localZipArg =
    typeof options.zip === "string" && options.zip.trim() ? options.zip.trim() : null;
  if (localZipArg && (options.source || process.env.ZCODE_IDE_PLUGIN_BASE_URL)) {
    warn("--zip 模式会忽略 --source / ZCODE_IDE_PLUGIN_BASE_URL。");
  }

  info(
    `zcode-idea ${pkg.version} 开始${dryRun ? "（dry-run 模式）" : ""}` +
      `${checkOnly ? "（仅检查模式）" : ""}。`,
  );

  // npm 包版本即插件版本：远端清单按这个版本寻址，避免读到 stable 的旧缓存。
  const pluginVersion = String(pkg.version ?? "").trim();

  /* ------------------------------ 1. 插件来源 ------------------------------ */
  let plugin;
  if (localZipArg) {
    info("第 1 步：使用本地插件包（--zip），跳过远端 manifest 与下载。");
    const localZipPath = path.resolve(localZipArg);
    if (!fs.existsSync(localZipPath) || !fs.statSync(localZipPath).isFile()) {
      throw new InstallError(`--zip 指定的插件包不存在或不是文件：${localZipPath}`);
    }
    const zipInfo = await validatePluginZip(localZipPath);
    plugin = { mode: "local", pluginVersion: zipInfo.pluginVersion, zipInfo, zipPath: localZipPath };
    info(
      `本地插件包校验通过：${localZipPath}（插件版本 ${zipInfo.pluginVersion}，` +
        `${formatBytes(zipInfo.size)}，sha256 ${zipInfo.sha256.slice(0, 12)}…）`,
    );
  } else {
    const source = resolvePluginSource({
      source: options.source,
      env: process.env,
      allowHttp,
    });
    if (source.isDefault) {
      warn("正在使用七牛测试域名（HTTP），生产环境请用 --source 指定 HTTPS 域名。");
    } else if (source.isHttp) {
      warn(`使用 HTTP 插件源（仅限联调）：${source.baseUrl}`);
    }
    const expectedManifestUrl = `${source.baseUrl}/${pluginVersion}/manifest.json`;
    info(`npm 包/插件版本 = ${pluginVersion}；清单 = ${expectedManifestUrl}`);
    const bundle = await fetchManifestBundle({
      baseUrl: source.baseUrl,
      version: pluginVersion,
      retries: 3,
    });
    if (bundle.manifest.pluginVersion !== pluginVersion) {
      throw new InstallError(
        `npm 包/插件版本 ${pluginVersion} 与远端清单版本 ${bundle.manifest.pluginVersion} 不匹配` +
          `（${bundle.manifestUrl}）。请确认 npm 包与插件版本一致后重新发布。`,
      );
    }
    plugin = {
      mode: "remote",
      pluginVersion: bundle.manifest.pluginVersion,
      sha256: bundle.manifest.sha256,
      size: bundle.manifest.size,
      archiveUrl: bundle.archiveUrl,
      manifestUrl: bundle.manifestUrl,
      cachePath: getCachedArchivePath(bundle.manifest.sha256),
      zipInfo: null,
      zipPath: null,
    };
    info(
      `manifest 验签通过：${bundle.manifestUrl}（版本 ${plugin.pluginVersion}），` +
        `${formatBytes(plugin.size)}，sha256 ${plugin.sha256.slice(0, 12)}…`,
    );
    info(`插件包地址：${plugin.archiveUrl}`);
  }

  // --clean-cache 只保留本次使用的版本；--zip 本地包按自身 sha256 保留同内容缓存。
  const cacheKeep =
    plugin.mode === "remote" ? [plugin.sha256] : [plugin.zipInfo.sha256];
  const cacheKeepNote =
    plugin.mode === "remote" ? "，保留本次使用的版本" : "，保留本次本地包对应的缓存";

  /* ------------------------------ 2. 发现 ------------------------------ */
  let targets;
  if (explicitPaths.length > 0) {
    info(`第 2 步：使用 --target 指定的 ${explicitPaths.length} 个目标（跳过发现）。`);
    targets = explicitPaths.map(makeExplicitTarget);
    for (const target of targets) info(`  - ${formatTarget(target)}`);
  } else {
    info("第 2 步：发现本机 JetBrains IDE…");
    const discovered = discoverTargetsDetailed();
    if (discovered.skipped.length > 0) {
      warn(
        `已跳过 ${discovered.skipped.length} 个不可写的 IDE 安装目录（需要管理员权限）。`,
      );
    }
    targets = discovered.targets;
    if (targets.length === 0) {
      throw new InstallError(
        "没有发现任何可用的 JetBrains IDE。可以用 --target <plugins 目录> 直接指定安装位置，例如：" +
          "C:\\Users\\<你>\\AppData\\Roaming\\JetBrains\\IntelliJIdea2026.2\\plugins",
      );
    }
    info(`发现 ${targets.length} 个可用目标：`);
    targets.forEach((target, index) => info(`  ${index + 1}) ${formatTarget(target)}`));
  }

  /* ------------------------------ 3. 选择 ------------------------------ */
  if (explicitPaths.length > 0) {
    info(`第 3 步：已由 --target 指定 ${targets.length} 个目标，跳过选择。`);
  } else if (installAll) {
    info(`第 3 步：--all，处理全部 ${targets.length} 个目标。`);
  } else if (targets.length === 1) {
    info(`第 3 步：只有一个目标，自动选择：${formatTarget(targets[0])}`);
  } else {
    info("第 3 步：请选择要安装的 IDE。");
    targets = await selectTargets(targets);
    info(`已选择 ${targets.length} 个目标。`);
  }

  /* ------------------------------ 4. 版本对比 ------------------------------ */
  info("第 4 步：对比已安装版本…");
  const rows = [];
  for (const target of targets) {
    const installed = await readInstalledPlugin(target.pluginsDir);
    if (installed.installed && !installed.version) {
      warn(
        `${targetLabel(target)}：存在 zcode-ide 但无法读取版本` +
          `（${installed.error ?? "未知原因"}），按未安装处理。`,
      );
    }
    let status;
    if (!installed.version) status = "missing";
    else {
      const comparison = comparePluginVersions(installed.version, plugin.pluginVersion);
      status = comparison < 0 ? "update" : comparison === 0 ? "latest" : "downgrade";
    }
    const action =
      force || status === "missing" || status === "update" ? "install" : "skip";
    rows.push({ target, installedVersion: installed.version, status, action });
  }

  info("版本对比：");
  info("  目标 | 已安装 | 可用 | 状态");
  for (const row of rows) {
    info(
      `  ${targetLabel(row.target)} | ${row.installedVersion ?? "未安装"} | ` +
        `${plugin.pluginVersion} | ${statusLabel(row, force)}`,
    );
  }
  for (const row of rows) {
    if (row.status === "downgrade" && row.action === "skip") {
      warn(
        `跳过降级：${targetLabel(row.target)} 已安装 ${row.installedVersion}，` +
          `远端 ${plugin.pluginVersion} 更低（--force 可强制降级）。`,
      );
    }
  }

  if (checkOnly) {
    info("--check 完成：未下载插件包、未关闭 IDE、未安装。");
    return 0;
  }

  // dry-run 的清理预览是纯只读的，放在 pending 判断之前：
  // 即使所有目标都已是最新，也能看到清理计划。
  if (dryRun && cleanCache) {
    try {
      const plan = await prunePluginCache({ keep: cacheKeep, dryRun: true });
      info(
        `dry-run：安装后将清理 ${plan.removed.length} 个旧缓存` +
          `（释放约 ${formatBytes(plan.freedBytes)}）${cacheKeepNote}。`,
      );
    } catch (err) {
      warn(`缓存清理预览失败，已跳过：${err.message}`);
    }
  }

  const pending = rows.filter((row) => row.action === "install");
  if (pending.length === 0) {
    info("没有需要安装的目标（已是最新或已跳过降级）。加 --force 可强制重装。");
    return 0;
  }

  info("安装计划：");
  for (const row of pending) {
    info(
      `  - ${targetLabel(row.target)} → ${path.join(row.target.pluginsDir, PLUGIN_DIR_NAME)}`,
    );
  }
  if (plugin.mode === "local") {
    info(`  插件包：${plugin.zipPath}（本地 --zip）`);
  } else if (isCachePresent(plugin.sha256, plugin.size)) {
    info(`  插件包：复用本地缓存 ${plugin.cachePath}`);
  } else {
    info(`  插件包：下载 ${plugin.archiveUrl} → ${plugin.cachePath}`);
  }

  if (dryRun) {
    info("dry-run 完成：未下载插件包、未关闭 IDE、未解压、未启动。");
    return 0;
  }

  /* ------------------------------ 5. 关闭 IDE ------------------------------ */
  info("第 5 步：关闭需要安装的 IDE（仅对应产品）。");
  await closeSelectedProcesses({
    targets: pending.map((row) => row.target),
    timeoutSec,
    dryRun: false,
    assumeYes,
    interactive,
    confirm: confirmClose,
  });

  // IDE 退出后，它派生的 ZCode server / agent / 远控桥可能变成孤儿，
  // 继续锁着 plugins/zcode-ide（Windows 上会让删目录/解压直接失败）。
  await killPluginDirHolders(
    pending.map((row) => path.join(row.target.pluginsDir, PLUGIN_DIR_NAME)),
  );

  /* ------------------------------ 6. 准备并解压 ------------------------------ */
  let zipInfo;
  if (plugin.mode === "local") {
    zipInfo = plugin.zipInfo;
    info(`第 6 步：使用本地插件包（${formatBytes(zipInfo.size)}）。`);
  } else {
    info("第 6 步：准备插件包（下载或复用缓存）…");
    const archive = await ensurePluginArchive({
      archiveUrl: plugin.archiveUrl,
      sha256: plugin.sha256,
      size: plugin.size,
    });
    zipInfo = await validatePluginZip(archive.zipPath, {
      expectedSha256: plugin.sha256,
      expectedSize: plugin.size,
      expectedVersion: plugin.pluginVersion,
    });
    info(
      `插件包结构校验通过：${zipInfo.entryCount} 个条目 / ${zipInfo.fileCount} 个文件，` +
        `插件版本 ${zipInfo.pluginVersion}`,
    );
  }

  info("第 7 步：解压插件…");
  const succeeded = [];
  const failed = [];
  for (const { target } of pending) {
    info(`→ ${target.pluginsDir}`);
    try {
      const extractOptions = {
        zipPath: zipInfo.zipPath,
        pluginsDir: target.pluginsDir,
        expectedEntries: zipInfo.entryCount,
        expectedBytes: zipInfo.totalBytes,
      };
      let result;
      try {
        result = await extractPluginZip(extractOptions);
      } catch (err) {
        // 删除旧目录/覆盖文件时被占用：清理残留 node 进程后再试一次。
        if (!isDirectoryLockedError(err)) throw err;
        warn(`插件目录被占用，清理残留进程后重试：${err.message}`);
        await killPluginDirHolders([path.join(target.pluginsDir, PLUGIN_DIR_NAME)]);
        await new Promise((resolve) => setTimeout(resolve, 800));
        result = await extractPluginZip(extractOptions);
      }

      const installedJar = await findInstalledJar(result.pluginDir);
      if (!installedJar) {
        throw new InstallError("解压后未找到 lib/zcode-ide-*.jar，安装可能不完整。");
      }
      if (
        zipInfo.hasRuntime &&
        !(await pathExists(path.join(result.pluginDir, "runtime", "web", "index.html")))
      ) {
        throw new InstallError("解压后缺少 runtime/web/index.html，安装可能不完整。");
      }

      info(`安装完成：${result.pluginDir}（${result.files} 个文件，${formatBytes(result.bytes)}）`);
      succeeded.push({ target, result, jar: installedJar });
    } catch (err) {
      warn(`安装失败：${target.pluginsDir} — ${err.message}`);
      failed.push({ target, error: err });
    }
  }

  /* ------------------------------ 7. 汇总 + 启动 ------------------------------ */
  info("第 8 步：安装汇总。");
  if (succeeded.length > 0) {
    info(`成功 ${succeeded.length} 个：`);
    for (const { target, result } of succeeded) {
      info(`  - ${formatTarget(target)} → ${result.pluginDir}（${result.files} 个文件）`);
    }
  }
  if (failed.length > 0) {
    warn(`失败 ${failed.length} 个：`);
    for (const { target, error: failure } of failed) {
      warn(`  - ${target.pluginsDir}：${failure.message}`);
    }
  }

  if (succeeded.length > 0) {
    if (zipInfo.hasRuntime) {
      info("提示：安装的是完整包，已内置 runtime，打开面板无需额外下载。");
    } else {
      info(
        "提示：安装的是薄包，首次打开 ZCode 工具窗口时会按需下载 runtime，请保持网络可用。",
      );
    }
  }

  if (succeeded.length > 0 && !noLaunch) {
    for (const { target } of succeeded) {
      const executable = findLaunchCommand(target);
      if (!executable) {
        warn(`未找到 ${target.productName} 的可执行文件，请手动打开 IDE。`);
        continue;
      }
      await launchDetached(executable);
    }
  } else if (noLaunch) {
    info("已按 --no-launch 跳过启动。");
  }

  if (cleanCache) {
    if (succeeded.length > 0) {
      // 清理是收尾动作：失败只告警，不能改变安装结果与退出码。
      try {
        const pruned = await prunePluginCache({ keep: cacheKeep });
        info(
          `缓存清理完成：删除 ${pruned.removed.length} 个旧缓存，` +
            `释放 ${formatBytes(pruned.freedBytes)}${cacheKeepNote}。`,
        );
        for (const item of pruned.failed) {
          warn(`缓存清理失败：${item.path} — ${item.error}`);
        }
      } catch (err) {
        warn(`缓存清理失败，已跳过：${err.message}`);
      }
    } else {
      // 全部目标安装失败时保留旧缓存，方便回滚/重试。
      warn("安装失败，已跳过缓存清理。");
    }
  }

  if (failed.length > 0) {
    error(`${failed.length} 个目标安装失败，请查看上面的错误信息。`);
    return 1;
  }
  info("全部完成。请在 IDE 中打开 ZCode 工具窗口（View → Tool Windows → ZCode）。");
  return 0;
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function findInstalledJar(pluginDir) {
  try {
    const entries = await fsp.readdir(path.join(pluginDir, "lib"));
    return entries.find((name) => /^zcode-ide-.*\.jar$/i.test(name)) ?? null;
  } catch {
    return null;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err && (err.name === "ExitPromptError" || err.name === "AbortPromptError")) {
      warn("已取消。");
      process.exitCode = 130;
      return;
    }
    error(err?.message || String(err));
    if (err instanceof UsageError) info("用 --help 查看用法。");
    process.exitCode = err instanceof UsageError ? 2 : 1;
  });
