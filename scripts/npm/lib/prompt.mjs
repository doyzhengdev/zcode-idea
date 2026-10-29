/**
 * 交互提示。只有交互模式才会真正加载 @inquirer/prompts，
 * 非交互（CI/管道）路径不触发任何 TTY 依赖。
 */

import { info } from "./log.mjs";
import { formatTarget } from "./targets.mjs";

/**
 * 多选目标；一个都不选时重新提问。
 * @returns {Promise<Array>} 选中的目标
 */
export async function selectTargets(targets) {
  const { checkbox } = await import("@inquirer/prompts");
  for (;;) {
    const selectedIds = await checkbox({
      message: "选择要安装 ZCode 插件的 IDE（空格选择，回车确认）",
      choices: targets.map((target) => ({
        name: formatTarget(target),
        value: target.id,
        checked: targets.length === 1,
      })),
      pageSize: Math.min(15, Math.max(3, targets.length)),
      loop: false,
    });
    if (selectedIds.length > 0) {
      return targets.filter((target) => selectedIds.includes(target.id));
    }
    info("请至少选择一个 IDE。");
  }
}

/** 关闭 IDE 前的二次确认。 */
export async function confirmClose(message) {
  const { confirm } = await import("@inquirer/prompts");
  return confirm({ message, default: true });
}
