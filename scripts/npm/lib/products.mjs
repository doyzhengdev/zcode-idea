/**
 * JetBrains 产品注册表：配置目录前缀、进程名、安装目录名、可执行文件名、Toolbox key。
 *
 * 关键约定：
 * - 配置目录名形如 `<Product><YYYY.N>`（例如 IntelliJIdea2026.2），用 parseConfigDirName 解析；
 * - 安装目录名形如 `IntelliJ IDEA 2026.2`，用 inferProductFromName 解析；
 * - 产品 -> 进程名映射供关闭 IDE 使用，同一产品的多个版本只关一次。
 */

/**
 * 名称匹配器按数组顺序生效：社区版/CE 必须排在商业版前面，
 * 否则 `IntelliJ IDEA Community Edition` 会先命中 `^intellij idea`。
 */
export const PRODUCTS = [
  {
    id: "ideaCommunity",
    name: "IntelliJ IDEA Community",
    configPrefixes: ["IdeaIC"],
    winProcesses: ["idea64.exe", "idea.exe"],
    unixProcesses: ["idea"],
    winExes: ["idea64.exe", "idea.exe"],
    macApps: ["IntelliJ IDEA CE.app"],
    macBins: ["idea"],
    linuxScripts: ["idea.sh"],
    toolboxKeys: ["IDEA-C"],
    nameMatchers: [
      /^intellij idea (community|ce)\b/,
      /^intellijidea ?(community|ce)\b/,
      /^idea-?c\b/,
      /^idea-?i?c\b/,
      /^ideaic\b/,
      /intellij-idea-community/,
      /^intellij idea ce\.app$/,
    ],
  },
  {
    id: "ideaUltimate",
    name: "IntelliJ IDEA Ultimate",
    configPrefixes: ["IntelliJIdea"],
    winProcesses: ["idea64.exe", "idea.exe"],
    unixProcesses: ["idea"],
    winExes: ["idea64.exe", "idea.exe"],
    macApps: ["IntelliJ IDEA.app"],
    macBins: ["idea"],
    linuxScripts: ["idea.sh"],
    toolboxKeys: ["IDEA-U"],
    nameMatchers: [/^intellij ?idea\b/, /^idea-?u\b/, /^idea-?i?u\b/, /intellij-idea-ultimate/],
  },
  {
    id: "pycharmCommunity",
    name: "PyCharm Community",
    configPrefixes: ["PyCharmCE"],
    winProcesses: ["pycharm64.exe"],
    unixProcesses: ["pycharm"],
    winExes: ["pycharm64.exe"],
    macApps: ["PyCharm CE.app"],
    macBins: ["pycharm"],
    linuxScripts: ["pycharm.sh"],
    toolboxKeys: ["PyCharm-C"],
    nameMatchers: [
      /^pycharm (community|ce|educational)\b/,
      /^pycharm-?c\b/,
      /^pycharmce\b/,
    ],
  },
  {
    id: "pycharm",
    name: "PyCharm Professional",
    configPrefixes: ["PyCharm"],
    winProcesses: ["pycharm64.exe"],
    unixProcesses: ["pycharm"],
    winExes: ["pycharm64.exe"],
    macApps: ["PyCharm.app"],
    macBins: ["pycharm"],
    linuxScripts: ["pycharm.sh"],
    toolboxKeys: ["PyCharm-P"],
    nameMatchers: [/^pycharm\b/, /^pycharm-?p\b/],
  },
  {
    id: "androidStudio",
    name: "Android Studio",
    configPrefixes: ["AndroidStudio"],
    winProcesses: ["studio64.exe"],
    unixProcesses: ["studio"],
    winExes: ["studio64.exe"],
    macApps: ["Android Studio.app"],
    macBins: ["studio"],
    linuxScripts: ["studio.sh"],
    toolboxKeys: ["AndroidStudio"],
    nameMatchers: [/android ?studio/],
  },
  {
    id: "webstorm",
    name: "WebStorm",
    configPrefixes: ["WebStorm"],
    winProcesses: ["webstorm64.exe"],
    unixProcesses: ["webstorm"],
    winExes: ["webstorm64.exe"],
    macApps: ["WebStorm.app"],
    macBins: ["webstorm"],
    linuxScripts: ["webstorm.sh"],
    toolboxKeys: ["WebStorm"],
    nameMatchers: [/webstorm/],
  },
  {
    id: "phpstorm",
    name: "PhpStorm",
    configPrefixes: ["PhpStorm"],
    winProcesses: ["phpstorm64.exe"],
    unixProcesses: ["phpstorm"],
    winExes: ["phpstorm64.exe"],
    macApps: ["PhpStorm.app"],
    macBins: ["phpstorm"],
    linuxScripts: ["phpstorm.sh"],
    toolboxKeys: ["PhpStorm"],
    nameMatchers: [/phpstorm/],
  },
  {
    id: "goland",
    name: "GoLand",
    configPrefixes: ["GoLand"],
    winProcesses: ["goland64.exe"],
    unixProcesses: ["goland"],
    winExes: ["goland64.exe"],
    macApps: ["GoLand.app"],
    macBins: ["goland"],
    linuxScripts: ["goland.sh"],
    toolboxKeys: ["GoLand"],
    nameMatchers: [/goland/],
  },
  {
    id: "clion",
    name: "CLion",
    configPrefixes: ["CLion"],
    winProcesses: ["clion64.exe"],
    unixProcesses: ["clion"],
    winExes: ["clion64.exe"],
    macApps: ["CLion.app"],
    macBins: ["clion"],
    linuxScripts: ["clion.sh"],
    toolboxKeys: ["CLion"],
    nameMatchers: [/clion/],
  },
  {
    id: "datagrip",
    name: "DataGrip",
    configPrefixes: ["DataGrip"],
    winProcesses: ["datagrip64.exe"],
    unixProcesses: ["datagrip"],
    winExes: ["datagrip64.exe"],
    macApps: ["DataGrip.app"],
    macBins: ["datagrip"],
    linuxScripts: ["datagrip.sh"],
    toolboxKeys: ["DataGrip"],
    nameMatchers: [/datagrip/],
  },
  {
    id: "rider",
    name: "Rider",
    configPrefixes: ["Rider"],
    winProcesses: ["rider64.exe"],
    unixProcesses: ["rider"],
    winExes: ["rider64.exe"],
    macApps: ["Rider.app"],
    macBins: ["rider"],
    linuxScripts: ["rider.sh"],
    toolboxKeys: ["Rider"],
    nameMatchers: [/^rider\b/],
  },
  {
    id: "rubymine",
    name: "RubyMine",
    configPrefixes: ["RubyMine"],
    winProcesses: ["rubymine64.exe"],
    unixProcesses: ["rubymine"],
    winExes: ["rubymine64.exe"],
    macApps: ["RubyMine.app"],
    macBins: ["rubymine"],
    linuxScripts: ["rubymine.sh"],
    toolboxKeys: ["RubyMine"],
    nameMatchers: [/rubymine/],
  },
  {
    id: "aqua",
    name: "Aqua",
    configPrefixes: ["Aqua"],
    winProcesses: ["aqua64.exe"],
    unixProcesses: ["aqua"],
    winExes: ["aqua64.exe"],
    macApps: ["Aqua.app"],
    macBins: ["aqua"],
    linuxScripts: ["aqua.sh"],
    toolboxKeys: ["Aqua"],
    nameMatchers: [/^aqua\b/],
  },
  {
    id: "rustrover",
    name: "RustRover",
    configPrefixes: ["RustRover"],
    winProcesses: ["rustrover64.exe"],
    unixProcesses: ["rustrover"],
    winExes: ["rustrover64.exe"],
    macApps: ["RustRover.app"],
    macBins: ["rustrover"],
    linuxScripts: ["rustrover.sh"],
    toolboxKeys: ["RustRover"],
    nameMatchers: [/rustrover/],
  },
  {
    id: "dataspell",
    name: "DataSpell",
    configPrefixes: ["DataSpell"],
    winProcesses: ["dataspell64.exe"],
    unixProcesses: ["dataspell"],
    winExes: ["dataspell64.exe"],
    macApps: ["DataSpell.app"],
    macBins: ["dataspell"],
    linuxScripts: ["dataspell.sh"],
    toolboxKeys: ["DataSpell"],
    nameMatchers: [/dataspell/],
  },
  {
    id: "writerside",
    name: "Writerside",
    configPrefixes: ["Writerside"],
    winProcesses: ["writerside64.exe"],
    unixProcesses: ["writerside"],
    winExes: ["writerside64.exe"],
    macApps: ["Writerside.app"],
    macBins: ["writerside"],
    linuxScripts: ["writerside.sh"],
    toolboxKeys: ["Writerside"],
    nameMatchers: [/writerside/],
  },
  {
    id: "mps",
    name: "MPS",
    configPrefixes: ["MPS"],
    winProcesses: ["mps64.exe"],
    unixProcesses: ["mps"],
    winExes: ["mps64.exe"],
    macApps: ["MPS.app"],
    macBins: ["mps"],
    linuxScripts: ["mps.sh"],
    toolboxKeys: ["MPS"],
    nameMatchers: [/^intellij mps\b/, /^mps\b/, /\bmps\b/],
  },
];

export const PRODUCT_BY_ID = new Map(PRODUCTS.map((product) => [product.id, product]));

/** 配置目录前缀 -> 产品（小写键，匹配时大小写不敏感）。 */
export const CONFIG_PREFIX_MAP = new Map();
for (const product of PRODUCTS) {
  for (const prefix of product.configPrefixes) {
    CONFIG_PREFIX_MAP.set(prefix.toLowerCase(), product);
  }
}

/** Toolbox 应用目录名 -> 产品（小写键）。 */
export const TOOLBOX_KEY_MAP = new Map();
for (const product of PRODUCTS) {
  for (const key of product.toolboxKeys) {
    TOOLBOX_KEY_MAP.set(key.toLowerCase(), product);
  }
}

/** 这些名字即使带年份后缀也不是 IDE 配置目录（防御性排除）。 */
const EXCLUDED_CONFIG_NAMES = new Set(
  [
    "toolbox",
    "daemon",
    "consentoptions",
    "permanentdeviceid",
    "permanentuserid",
    "bl",
    "crl",
    "discovery",
    "plugins",
    "options",
  ].map((name) => name.toLowerCase()),
);

const CONFIG_DIR_RE = /^(.*?)(\d{4}\.\d+)$/;
// 只接受独立出现的版本号（前面不能紧跟数字），避免把 241.14494.240 这类 build 号误当版本
const INSTALL_VERSION_RE = /(?:^|[^0-9])(\d{4}\.\d+(?:\.\d+)?)(?![0-9])/;

/**
 * 解析 JetBrains 配置目录名（`<Product><YYYY.N>`）。
 * @returns {{product: object, version: string} | null}
 */
export function parseConfigDirName(name) {
  if (typeof name !== "string" || !name) return null;
  if (EXCLUDED_CONFIG_NAMES.has(name.toLowerCase())) return null;
  const match = CONFIG_DIR_RE.exec(name);
  if (!match) return null;
  const product = CONFIG_PREFIX_MAP.get(match[1].toLowerCase());
  if (!product) return null;
  return { product, version: match[2] };
}

/**
 * 从安装目录名 / .app 名 / Toolbox key 推断产品与版本。
 * 解析不出产品时返回 null；版本缺失时 version 为空字符串。
 */
export function inferProductFromName(name) {
  if (typeof name !== "string" || !name.trim()) return null;
  const config = parseConfigDirName(name);
  if (config) return config;

  let base = name.trim();
  if (/\.app$/i.test(base)) base = base.slice(0, -4);
  const lower = base.toLowerCase();
  const versionMatch = INSTALL_VERSION_RE.exec(base);
  const version = versionMatch ? versionMatch[1] : "";

  for (const product of PRODUCTS) {
    if (product.nameMatchers.some((pattern) => pattern.test(lower))) {
      return { product, version };
    }
  }
  // Toolbox key 精确匹配（IDEA-U / PyCharm-C / AndroidStudio 等）
  const byToolboxKey = TOOLBOX_KEY_MAP.get(lower);
  if (byToolboxKey) return { product: byToolboxKey, version };
  return null;
}

/**
 * 从 plugins 目录反推产品。依次看自身、父目录、祖父目录，
 * 以兼容 `.../<Product><Version>/plugins`、`.../<IDE 安装目录>/plugins`、`*.app/Contents/plugins`。
 */
export function inferProductFromPath(pluginsDir) {
  if (typeof pluginsDir !== "string" || !pluginsDir) return null;
  const parts = pluginsDir.split(/[\\/]+/).filter(Boolean);
  const candidates = parts.slice(-4).reverse();
  for (const part of candidates) {
    const inferred = inferProductFromName(part);
    if (inferred) return inferred;
  }
  return null;
}

/** 产品对应的进程名：Windows 用 `.exe`，macOS/Linux 用无后缀的小写名。 */
export function getProcessNames(product, platform = process.platform) {
  if (!product) return [];
  return platform === "win32" ? product.winProcesses : product.unixProcesses;
}

export function describeProduct(product, version = "") {
  if (!product) return "未识别的 IDE";
  return `${product.name}${version ? ` ${version}` : ""}`;
}
