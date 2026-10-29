/**
 * 控制台输出统一走这里，保证每行都带 [zcode-idea] 前缀。
 * 进度条在 TTY 下用 \r 原地刷新，非 TTY（CI/管道）降级为每 10% 一行。
 */

const PREFIX = "[zcode-idea]";

export function info(message) {
  console.log(`${PREFIX} ${message}`);
}

export function warn(message) {
  console.warn(`${PREFIX} 警告：${message}`);
}

export function error(message) {
  console.error(`${PREFIX} 错误：${message}`);
}

/** 交互能力判定：stdin 与 stdout 都是 TTY 才算交互环境。 */
export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}
