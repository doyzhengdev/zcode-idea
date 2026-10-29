/**
 * 关闭 IDE 进程。
 *
 * 只处理所选目标对应的产品进程（同一产品多版本只关一次），
 * 先优雅关闭（Windows: taskkill 不带 /F；macOS/Linux: SIGTERM），
 * 轮询到超时仍存活才强制结束（Windows /F；Unix SIGKILL）。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { InstallError } from "./errors.mjs";
import { info, warn } from "./log.mjs";
import { getProcessNames, PRODUCT_BY_ID } from "./products.mjs";

const POLL_INTERVAL_MS = 500;

/** 列出当前运行的进程（只匹配传入的进程名）。 */
export function listProcesses(names, platform = process.platform) {
  if (!names.length) return [];
  return platform === "win32" ? listWindowsProcesses(names) : listUnixProcesses(names);
}

function listWindowsProcesses(names) {
  const found = new Map();
  for (const name of names) {
    const result = spawnSync(
      "tasklist",
      ["/FI", `IMAGENAME eq ${name}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.error) {
      throw new InstallError(
        `无法执行 tasklist（${result.error.message}）。请在 Windows 上运行，或手动关闭 IDE。`,
      );
    }
    for (const line of String(result.stdout || "").split(/\r?\n/)) {
      const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (!match) continue;
      found.set(`${match[1].toLowerCase()}:${match[2]}`, {
        name: match[1],
        pid: Number(match[2]),
      });
    }
  }
  return [...found.values()];
}

function listUnixProcesses(names) {
  const result = spawnSync("ps", ["-A", "-o", "pid=,comm="], { encoding: "utf8" });
  if (result.error) {
    throw new InstallError(
      `无法执行 ps（${result.error.message}）。请手动关闭 IDE 后重试。`,
    );
  }
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const found = [];
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const base = path.basename(match[2]).toLowerCase();
    if (!wanted.has(base)) continue;
    found.push({ name: base, pid: Number(match[1]) });
  }
  return found;
}

/**
 * 关闭所选目标对应的 IDE。
 *
 * @param {object} params
 * @param {Array} params.targets 已选择的目标
 * @param {"win32"|"darwin"|"linux"|string} [params.platform]
 * @param {number} [params.timeoutSec]
 * @param {boolean} [params.dryRun]
 * @param {boolean} [params.assumeYes] 传了 --yes
 * @param {boolean} [params.interactive] 是否交互终端
 * @param {(message: string) => Promise<boolean>} [params.confirm]
 */
export async function closeSelectedProcesses({
  targets,
  platform = process.platform,
  timeoutSec = 30,
  dryRun = false,
  assumeYes = false,
  interactive = false,
  confirm = null,
}) {
  const products = [];
  for (const target of targets) {
    const product = target.productId ? PRODUCT_BY_ID.get(target.productId) : null;
    if (product && !products.some((item) => item.id === product.id)) products.push(product);
  }

  if (!products.length) {
    info("未能从目标识别出 IDE 产品，跳过关闭 IDE。");
    return { running: [], skipped: true };
  }

  const names = [...new Set(products.flatMap((product) => getProcessNames(product, platform)))];
  const running = listProcesses(names, platform);
  const productLabel = products.map((product) => product.name).join("、");

  if (!running.length) {
    info(`没有检测到运行中的 ${productLabel} 进程，继续安装。`);
    return { running: [] };
  }

  info(`检测到以下 ${productLabel} 进程：`);
  for (const proc of running) info(`  - ${proc.name}（pid ${proc.pid}）`);

  if (dryRun) {
    info("dry-run：跳过关闭 IDE（真实执行时会先优雅关闭，超时后再强制结束）。");
    return { running, dryRun: true };
  }

  // Windows 上 IDE 以管理员身份启动时，普通终端无法结束它。提前提示，
  // 避免等到超时/强制结束失败后才让用户猜原因。
  const elevated = platform === "win32" ? isWindowsElevated() : null;
  if (elevated === false) {
    const hint = elevationHint({ platform, elevated });
    if (hint) warn(hint);
  }

  if (!assumeYes) {
    if (!interactive || typeof confirm !== "function") {
      warn("非交互环境未传 --yes，跳过关闭 IDE。若安装失败，请先手动退出 IDE 后重试。");
      return { running, skipped: true };
    }
    const confirmed = await confirm(
      `将关闭以上 ${running.length} 个进程（未保存内容可能丢失，IDE 默认失焦时保存），是否继续？`,
    );
    if (!confirmed) {
      throw new InstallError("已取消：请先手动关闭 IDE，再重新运行安装命令。");
    }
  }

  const attemptedNames = [...new Set(running.map((proc) => proc.name))];
  let accessDenied = false;
  for (const name of attemptedNames) {
    const result = sendTerminate(name, platform);
    if (result.accessDenied) accessDenied = true;
  }

  // 关闭请求被拒绝：IDE 以管理员身份运行，普通终端拿不到句柄。
  // 直接弹 UAC 用提权 ps1 强杀，避免白等 timeout 秒再失败。
  if (accessDenied && platform === "win32" && elevated === false) {
    warn("关闭 IDE 被拒绝（权限不足），正在请求管理员权限…");
    const elevatedOk = runElevatedKill({
      pids: running.map((proc) => proc.pid),
      names: attemptedNames,
    });
    if (elevatedOk) {
      await sleep(1000);
      const leftAfterElevation = isStillRunningNow(attemptedNames, names, platform);
      if (leftAfterElevation.length === 0) {
        info("已通过管理员权限结束 IDE 进程。");
        return { running, elevated: true };
      }
    }
  }

  info(`已请求关闭 ${attemptedNames.join("、")}，等待退出（最多 ${timeoutSec} 秒）…`);

  const isStillRunning = () => isStillRunningNow(attemptedNames, names, platform);

  const deadline = Date.now() + timeoutSec * 1000;
  let left = isStillRunning();
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    left = isStillRunning();
  }

  if (left.length === 0) {
    info("IDE 已退出。");
    return { running };
  }

  const forcedNames = [...new Set(left.map((proc) => proc.name))];
  warn(
    `等待 ${timeoutSec} 秒后仍有 ${left.length} 个进程未退出，强制结束：${forcedNames.join("、")}`,
  );
  for (const name of forcedNames) {
    const pids = left.filter((proc) => proc.name === name).map((proc) => proc.pid);
    sendForceKill(name, platform, pids);
  }
  await sleep(1000);

  left = isStillRunning();
  if (left.length > 0 && platform === "win32" && elevated === false) {
    warn("强制结束仍失败，再次请求管理员权限…");
    if (runElevatedKill({ pids: left.map((proc) => proc.pid), names: forcedNames })) {
      await sleep(1000);
      left = isStillRunning();
    }
  }

  if (left.length > 0) {
    const hint = elevationHint({ platform, elevated });
    throw new InstallError(
      `无法关闭 IDE 进程：${[...new Set(left.map((proc) => proc.name))].join("、")}。` +
        (hint ?? "请手动退出后重试（可用 --timeout 增加等待时间）。"),
    );
  }
  info("已强制结束 IDE 进程。");
  return { running };
}

/** 目标进程里仍在运行的部分。 */
function isStillRunningNow(attemptedNames, names, platform) {
  const attempted = new Set(attemptedNames.map((name) => name.toLowerCase()));
  return listProcesses(names, platform).filter((proc) => attempted.has(proc.name.toLowerCase()));
}

/**
 * 判断 taskkill 输出是否是"权限不足"（IDE 以管理员身份运行时普通终端拿不到句柄）。
 *
 * 中文系统输出「拒绝访问」，英文是 "Access is denied"。
 */
export function isAccessDeniedOutput(text) {
  const value = String(text || "");
  return /拒绝访问|access is denied|拒绝的访问/i.test(value) || /\bERROR:\s*5\b/.test(value);
}

/** 解析 `IsInRole(Administrator)` 的输出（"True"/"False"）。 */
export function parseElevationOutput(text) {
  const value = String(text || "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

let cachedElevation = null;

/** 当前进程是否以管理员权限运行（仅 Windows 有意义；无法判断返回 null）。 */
export function isWindowsElevated() {
  if (process.platform !== "win32") return null;
  if (cachedElevation !== null) return cachedElevation;
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  cachedElevation = result.error ? null : parseElevationOutput(result.stdout);
  return cachedElevation;
}

/** 需要管理员权限时的统一提示；无需提示返回 null。 */
export function elevationHint({ platform = process.platform, elevated = null } = {}) {
  if (platform !== "win32" || elevated === true) return null;
  return (
    "当前终端没有管理员权限。请用「以管理员身份运行」的 PowerShell / 终端重试，" +
    "或在弹出的 UAC 窗口选择「是」：npx zcode-idea@latest update"
  );
}

/**
 * 生成提权后要执行的 PowerShell 脚本（强杀 pid / 进程名 / 占用插件目录的 node 进程）。
 *
 * 独立成纯函数，便于单测校验转义（路径里的反斜杠、名称里的单引号）。
 */
export function buildElevatedKillScript({
  pids = [],
  names = [],
  pluginDirs = [],
  excludePids = [],
} = {}) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const pidList = pids.filter((pid) => Number.isFinite(pid) && pid > 0).join(",");
  const nameList = names.filter(Boolean).map(quote).join(",");
  const dirList = pluginDirs.filter(Boolean).map(quote).join(",");
  // 安装器自身的 node 进程命令行里也可能出现插件目录（例如 --zip/--target 传了完整路径），
  // 提权脚本是另一个进程，拿不到"自己"，必须显式排除，避免把自己杀掉。
  const excludeList = excludePids.filter((pid) => Number.isFinite(pid) && pid > 0).join(",");
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$pids=@(${pidList})`,
    `$names=@(${nameList})`,
    `$dirs=@(${dirList})`,
    `$exclude=@(${excludeList})`,
    "$hosts=@('node.exe','node','zcode.exe','zcode')",
    "foreach($id in $pids){ if($id -and ($exclude -notcontains $id)){ $null = & taskkill /F /T /PID $id 2>&1 } }",
    "foreach($n in $names){ if($n){ $null = & taskkill /F /T /IM $n 2>&1 } }",
    "$needles=@($dirs | Where-Object { $_ } | ForEach-Object { ($_ -replace '\\\\','/').ToLower() })",
    "if($needles.Count -gt 0){ Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($hosts -contains $_.Name.ToLower()) -and ($exclude -notcontains $_.ProcessId) } | ForEach-Object { $cmd=$_.CommandLine.Replace('\\','/').ToLower(); foreach($n in $needles){ if($cmd.Contains($n)){ $null = & taskkill /F /T /PID $_.ProcessId 2>&1; break } } } }",
    "Start-Sleep -Milliseconds 600",
    "$left=0",
    "foreach($id in $pids){ if(($exclude -notcontains $id) -and $id -and (Get-Process -Id $id -ErrorAction SilentlyContinue)){ $left++ } }",
    "if($left -gt 0){ exit 1 }",
    "exit 0",
  ].join("; ");
}

/** PowerShell `-EncodedCommand` 要求 UTF-16LE 再 base64。 */
export function encodePowerShellCommand(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

/**
 * 通过 UAC 提权强杀进程（会弹系统授权窗口）。
 *
 * 用 `-EncodedCommand` 内联脚本，**不落地 .ps1 文件**：`-ExecutionPolicy Bypass` 在
 * 组策略（MachinePolicy）下会被忽略，而内联命令不受"脚本执行策略"限制，即使机器上
 * `Get-ExecutionPolicy` 是 Restricted 也能执行。返回是否清理完成（用户取消 UAC 为 false）。
 */
export function runElevatedKill({ pids = [], names = [], pluginDirs = [] } = {}) {
  if (process.platform !== "win32") return false;
  const encoded = encodePowerShellCommand(
    buildElevatedKillScript({ pids, names, pluginDirs, excludePids: [process.pid] }),
  );
  info("正在请求管理员权限（会弹出 UAC 窗口，请选择「是」）…");
  // Start-Process -ArgumentList 不做自动加引号；encoded 是纯 base64，不含空格与引号。
  const inner = `-NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  const command = `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '${inner}'; exit $p.ExitCode`;
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  const detail = String(result.stderr || result.stdout || "").trim();
  if (result.error || result.status !== 0) {
    warn(
      "提权执行失败或已被取消" +
        `${detail ? `：${detail.split(/\r?\n/)[0]}` : ""}。` +
        "请用「以管理员身份运行」的终端手动执行安装命令，或手动结束占用的进程。",
    );
    return false;
  }
  return true;
}

function sendTerminate(name, platform) {
  if (platform === "win32") {
    // /T：连带子进程。IDE 会派生 ZCode server / agent / 远控桥等 node 子进程，
    // 只关父进程会让它们变成孤儿继续占用插件目录。
    const result = spawnSync("taskkill", ["/T", "/IM", name], {
      encoding: "utf8",
      windowsHide: true,
    });
    const output = `${result.stderr || ""}${result.stdout || ""}`.trim();
    if (result.error) {
      warn(`taskkill 不可用（${result.error.message}），请手动关闭 ${name}。`);
      return { ok: false, accessDenied: false };
    }
    if (result.status !== 0) {
      if (output) warn(`taskkill ${name} 返回 ${result.status}：${output}`);
      return { ok: false, accessDenied: isAccessDeniedOutput(output) };
    }
    return { ok: true, accessDenied: false };
  }
  const result = spawnSync("pkill", ["-TERM", "-x", name], { encoding: "utf8" });
  if (result.error) {
    warn(`pkill 不可用（${result.error.message}），请手动关闭 ${name}。`);
    return { ok: false, accessDenied: false };
  }
  return { ok: result.status === 0, accessDenied: false };
}

function sendForceKill(name, platform, pids = []) {
  if (platform === "win32") {
    // 优先按 pid + /T 树杀（更精确，也覆盖 /IM 匹配不到的别名进程）；pid 不可用时退回 /IM /T。
    if (pids.length > 0) {
      for (const pid of pids) {
        const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
          encoding: "utf8",
          windowsHide: true,
        });
        if (result.error || result.status !== 0) {
          const detail = String(result.stderr || result.stdout || "").trim();
          warn(
            `无法强制结束 ${name}（pid ${pid}）${detail ? `：${detail}` : ""}。` +
              "若 IDE 以管理员身份运行，请用管理员终端重试。",
          );
        }
      }
      return;
    }
    const result = spawnSync("taskkill", ["/F", "/T", "/IM", name], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim();
      warn(
        `无法强制结束 ${name}${detail ? `：${detail}` : ""}。` +
          "若 IDE 以管理员身份运行，请用管理员终端重试。",
      );
    }
    return;
  }
  if (platform === "darwin" && pids.length > 0) {
    const result = spawnSync("kill", ["-9", ...pids.map((pid) => String(pid))], {
      encoding: "utf8",
    });
    if (!result.error && result.status === 0) return;
  }
  const result = spawnSync("pkill", ["-9", "-x", name], { encoding: "utf8" });
  if (result.error) warn(`pkill 不可用（${result.error.message}），请手动关闭 ${name}。`);
}

/** 占用插件目录的常见宿主名：ZCode server / agent / 远控桥都是 node。 */
const HOLDER_PROCESS_HINTS = new Set(["node.exe", "node", "zcode.exe", "zcode"]);

function normalizeForMatch(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

/**
 * 判断一个进程命令行是否引用了任一插件目录。
 *
 * 纯函数：命令行里的分隔符可能是 `\` 或 `/`，盘符大小写也可能不同，
 * 统一归一化后再比较。
 */
export function commandLineReferencesDirs(commandLine, pluginDirs) {
  if (!commandLine) return false;
  const haystack = normalizeForMatch(commandLine);
  return pluginDirs.some((dir) => {
    const needle = normalizeForMatch(dir).replace(/\/+$/, "");
    return Boolean(needle) && haystack.includes(needle);
  });
}

/** 解析 `Get-CimInstance Win32_Process | ConvertTo-Json` 的输出（单个对象或数组）。 */
export function parseWindowsProcessJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map((item) => ({
      name: String(item?.Name ?? ""),
      pid: Number(item?.ProcessId ?? 0),
      commandLine: String(item?.CommandLine ?? ""),
    }))
    .filter((item) => Number.isFinite(item.pid) && item.pid > 0);
}

function listWindowsProcessSnapshots() {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) {
    warn(`无法枚举进程（${result.error.message}），跳过插件目录占用检查。`);
    return [];
  }
  return parseWindowsProcessJson(result.stdout);
}

function listUnixProcessSnapshots() {
  const result = spawnSync("ps", ["-A", "-o", "pid=,comm=,args="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) return [];
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), name: match[2], commandLine: match[3] }));
}

/**
 * 找出仍在引用插件目录的进程（典型：IDE 已退出但 ZCode server / agent 变成孤儿）。
 *
 * 这类进程会锁住 `plugins/zcode-ide` 下的 jar 与 runtime，导致删目录/解压失败。
 */
export function listPluginDirHolders(pluginDirs, platform = process.platform) {
  if (!pluginDirs.length) return [];
  const snapshots = platform === "win32" ? listWindowsProcessSnapshots() : listUnixProcessSnapshots();
  return snapshots.filter(
    (item) =>
      item.pid !== process.pid &&
      commandLineReferencesDirs(item.commandLine, pluginDirs) &&
      (platform !== "win32" || HOLDER_PROCESS_HINTS.has(item.name.toLowerCase())),
  );
}

/**
 * 结束占用插件目录的进程（IDE 已关闭后的清理步骤）。
 *
 * @returns {Promise<Array<{name: string, pid: number}>>} 被结束的进程
 */
export async function killPluginDirHolders(pluginDirs, { platform = process.platform } = {}) {
  const holders = listPluginDirHolders(pluginDirs, platform);
  if (!holders.length) return [];
  warn(
    `检测到 ${holders.length} 个进程仍占用插件目录（IDE 退出后残留的 node 子进程）：` +
      holders.map((item) => `${item.name}(pid ${item.pid})`).join("、"),
  );
  for (const holder of holders) {
    if (platform === "win32") {
      const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(holder.pid)], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.error || result.status !== 0) {
        const detail = String(result.stderr || result.stdout || "").trim();
        warn(
          `无法结束 ${holder.name}（pid ${holder.pid}）${detail ? `：${detail}` : ""}。` +
            "请在任务管理器结束该进程，或用管理员终端重试。",
        );
      }
    } else {
      spawnSync("kill", ["-9", String(holder.pid)], { encoding: "utf8" });
    }
  }
  await sleep(600);
  let left = listPluginDirHolders(pluginDirs, platform);
  if (left.length > 0 && platform === "win32" && isWindowsElevated() === false) {
    warn("结束残留进程被拒绝（权限不足），正在请求管理员权限…");
    if (runElevatedKill({ pids: left.map((item) => item.pid), pluginDirs })) {
      left = listPluginDirHolders(pluginDirs, platform);
    }
  }
  if (left.length > 0) {
    const hint = elevationHint({ platform, elevated: isWindowsElevated() });
    warn(
      `仍有 ${left.length} 个进程占用插件目录：` +
        `${left.map((item) => `${item.name}(pid ${item.pid})`).join("、")}。` +
        (hint ?? "请在任务管理器中结束它们后重试。"),
    );
  } else {
    info("已结束占用插件目录的残留进程。");
  }
  return holders;
}

/** 判断错误是否属于"目录被占用"（Windows 上删除/覆盖失败最常见的原因）。 */
export function isDirectoryLockedError(error) {
  const code = String(error?.code || "");
  if (["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(code)) return true;
  const message = String(error?.message || "");
  return (
    /\b(EBUSY|EPERM|EACCES|ENOTEMPTY)\b/.test(message) ||
    /being used by another process/i.test(message)
  );
}
