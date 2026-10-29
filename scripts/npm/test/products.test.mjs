import assert from "node:assert/strict";
import test from "node:test";
import {
  getProcessNames,
  inferProductFromName,
  inferProductFromPath,
  parseConfigDirName,
  PRODUCT_BY_ID,
} from "../lib/products.mjs";

test("解析配置目录名：产品 + 版本", () => {
  const cases = [
    ["IdeaIC2024.1", "ideaCommunity", "2024.1"],
    ["IntelliJIdea2026.2", "ideaUltimate", "2026.2"],
    ["WebStorm2025.2", "webstorm", "2025.2"],
    ["AndroidStudio2025.1", "androidStudio", "2025.1"],
    ["PyCharmCE2024.3", "pycharmCommunity", "2024.3"],
    ["DataGrip2025.1", "datagrip", "2025.1"],
  ];
  for (const [name, productId, version] of cases) {
    const parsed = parseConfigDirName(name);
    assert.ok(parsed, `${name} 应该被识别`);
    assert.equal(parsed.product.id, productId, name);
    assert.equal(parsed.version, version, name);
  }
});

test("排除非 IDE 目录", () => {
  for (const name of [
    "Toolbox",
    "Daemon",
    "consentOptions",
    "PermanentDeviceId",
    "PermanentUserId",
    "plugins",
    "options",
    "bl",
    "crl",
    "discovery",
    "IntelliJIdea",
    "WebStorm-2025.2",
  ]) {
    assert.equal(parseConfigDirName(name), null, `${name} 不应被识别为配置目录`);
  }
});

test("产品 -> 进程名映射", () => {
  assert.deepEqual(getProcessNames(PRODUCT_BY_ID.get("ideaUltimate"), "win32"), [
    "idea64.exe",
    "idea.exe",
  ]);
  assert.deepEqual(getProcessNames(PRODUCT_BY_ID.get("ideaCommunity"), "win32"), [
    "idea64.exe",
    "idea.exe",
  ]);
  assert.deepEqual(getProcessNames(PRODUCT_BY_ID.get("androidStudio"), "win32"), [
    "studio64.exe",
  ]);
  assert.deepEqual(getProcessNames(PRODUCT_BY_ID.get("pycharm"), "win32"), ["pycharm64.exe"]);
  assert.deepEqual(getProcessNames(PRODUCT_BY_ID.get("ideaUltimate"), "linux"), ["idea"]);
  assert.deepEqual(getProcessNames(PRODUCT_BY_ID.get("webstorm"), "darwin"), ["webstorm"]);
  assert.deepEqual(getProcessNames(PRODUCT_BY_ID.get("androidStudio"), "linux"), ["studio"]);
  assert.deepEqual(getProcessNames(null), []);
});

test("安装目录名 / .app / Toolbox key 推断产品", () => {
  const expectations = [
    ["IntelliJ IDEA 2026.2.2", "ideaUltimate", "2026.2.2"],
    ["IntelliJ IDEA Community Edition 2025.2", "ideaCommunity", "2025.2"],
    ["IntelliJ IDEA CE.app", "ideaCommunity", ""],
    ["IntelliJ IDEA.app", "ideaUltimate", ""],
    ["PyCharm CE.app", "pycharmCommunity", ""],
    ["PyCharm 2025.2", "pycharm", "2025.2"],
    ["RustRover 2025.2", "rustrover", "2025.2"],
    ["WebStorm.app", "webstorm", ""],
    ["IDEA-U", "ideaUltimate", ""],
    ["IDEA-C", "ideaCommunity", ""],
    ["PyCharm-C", "pycharmCommunity", ""],
    ["AndroidStudio", "androidStudio", ""],
    ["IntelliJ MPS 2025.2", "mps", "2025.2"],
    ["idea-IC-241.14494.240", "ideaCommunity", ""],
    ["idea-IU-252.1.2", "ideaUltimate", ""],
  ];
  for (const [name, productId, version] of expectations) {
    const inferred = inferProductFromName(name);
    assert.ok(inferred, `${name} 应该被识别`);
    assert.equal(inferred.product.id, productId, name);
    assert.equal(inferred.version, version, name);
  }
  assert.equal(inferProductFromName("zcode-idea-installer-test"), null);
  assert.equal(inferProductFromName("PermanentDeviceId"), null);
});

test("从 plugins 目录反推产品", () => {
  const fromConfig = inferProductFromPath(
    "C:\\Users\\me\\AppData\\Roaming\\JetBrains\\IntelliJIdea2026.2\\plugins",
  );
  assert.equal(fromConfig?.product.id, "ideaUltimate");
  assert.equal(fromConfig?.version, "2026.2");

  const fromInstall = inferProductFromPath("/opt/WebStorm-252.1/bin/plugins");
  assert.equal(fromInstall?.product.id, "webstorm");

  assert.equal(inferProductFromPath("/tmp/zcode-idea-installer-test/plugins"), null);
});
