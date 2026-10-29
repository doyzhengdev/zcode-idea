import assert from "node:assert/strict";
import test from "node:test";
import {
  buildElevatedKillScript,
  commandLineReferencesDirs,
  elevationHint,
  encodePowerShellCommand,
  isAccessDeniedOutput,
  isDirectoryLockedError,
  parseElevationOutput,
  parseWindowsProcessJson,
} from "../lib/processes.mjs";

test("命令行引用插件目录：反斜杠/正斜杠与大小写都算命中", () => {
  const dir = "C:\\Users\\Administrator\\AppData\\Roaming\\JetBrains\\IntelliJIdea2025.3\\plugins\\zcode-ide";
  assert.equal(
    commandLineReferencesDirs(
      "node.exe E:\\plugin\\runtime\\server\\dist\\entry-http.js",
      ["E:\\plugin\\runtime"],
    ),
    true,
  );
  assert.equal(
    commandLineReferencesDirs(
      '"C:\\Program Files\\nodejs\\node.exe" "c:/users/administrator/appdata/roaming/jetbrains/intellijidea2025.3/plugins/zcode-ide/runtime/server/dist/entry-http.js"',
      [dir],
    ),
    true,
  );
  assert.equal(
    commandLineReferencesDirs("node.exe entry-http.js", [dir]),
    false,
  );
  assert.equal(commandLineReferencesDirs("", [dir]), false);
  assert.equal(commandLineReferencesDirs("node.exe x.js", []), false);
});

test("目录尾部分隔符不影响匹配", () => {
  assert.equal(
    commandLineReferencesDirs("node C:/x/plugins/zcode-ide/runtime/a.js", [
      "C:\\x\\plugins\\zcode-ide\\",
    ]),
    true,
  );
});

test("解析 Windows 进程 JSON：数组、单对象、坏数据", () => {
  const array = parseWindowsProcessJson(
    JSON.stringify([
      { ProcessId: 123, Name: "node.exe", CommandLine: "node a.js" },
      { ProcessId: 456, Name: "idea64.exe", CommandLine: "idea" },
    ]),
  );
  assert.deepEqual(array, [
    { pid: 123, name: "node.exe", commandLine: "node a.js" },
    { pid: 456, name: "idea64.exe", commandLine: "idea" },
  ]);

  const single = parseWindowsProcessJson(
    JSON.stringify({ ProcessId: 7, Name: "node.exe", CommandLine: null }),
  );
  assert.deepEqual(single, [{ pid: 7, name: "node.exe", commandLine: "" }]);

  assert.deepEqual(parseWindowsProcessJson(""), []);
  assert.deepEqual(parseWindowsProcessJson("not json"), []);
  assert.deepEqual(
    parseWindowsProcessJson(JSON.stringify([{ ProcessId: 0, Name: "x" }])),
    [],
    "pid 无效的条目应被丢弃",
  );
});

test("目录被占用错误识别", () => {
  assert.equal(isDirectoryLockedError(Object.assign(new Error("boom"), { code: "EBUSY" })), true);
  assert.equal(isDirectoryLockedError(Object.assign(new Error("boom"), { code: "EPERM" })), true);
  assert.equal(
    isDirectoryLockedError(
      new Error("EBUSY: resource busy or locked, unlink 'lib/zcode-ide-0.0.6.jar'"),
    ),
    true,
  );
  assert.equal(
    isDirectoryLockedError(new Error("The process cannot access the file because it is being used by another process")),
    true,
  );
  assert.equal(isDirectoryLockedError(new Error("ENOENT: no such file")), false);
  assert.equal(isDirectoryLockedError(null), false);
});

test("任务管理器权限不足输出识别（中英文）", () => {
  assert.equal(isAccessDeniedOutput("错误: 拒绝访问。"), true);
  assert.equal(isAccessDeniedOutput("ERROR: Access is denied."), true);
  assert.equal(isAccessDeniedOutput("ERROR: The process \"1234\" not found."), false);
  assert.equal(isAccessDeniedOutput(""), false);
});

test("管理员权限检测输出解析与提示文案", () => {
  assert.equal(parseElevationOutput("True\r\n"), true);
  assert.equal(parseElevationOutput("false"), false);
  assert.equal(parseElevationOutput("garbage"), null);

  assert.match(elevationHint({ platform: "win32", elevated: false }), /管理员/);
  assert.equal(elevationHint({ platform: "win32", elevated: true }), null);
  assert.equal(elevationHint({ platform: "darwin", elevated: false }), null);
  // 无法判定（null）时仍给提示：宁可多说一句，也好过让用户猜。
  assert.match(elevationHint({ platform: "win32", elevated: null }), /管理员/);
});

test("提权脚本：pid/名称/目录都写进内联命令，反斜杠与单引号正确转义", () => {
  const script = buildElevatedKillScript({
    pids: [1234, 5678, 0, NaN],
    names: ["idea64.exe", "O'Brien.exe"],
    pluginDirs: ["C:\\Users\\<user>\\AppData\\Roaming\\JetBrains\\IntelliJIdea2026.2\\plugins\\zcode-ide"],
  });
  assert.match(script, /\$pids=@\(1234,5678\)/);
  assert.match(script, /'idea64\.exe','O''Brien\.exe'/);
  assert.ok(
    script.includes("$dirs=@('C:\\Users\\<user>\\AppData\\Roaming\\JetBrains\\IntelliJIdea2026.2\\plugins\\zcode-ide')"),
    "插件目录应原样写入 $dirs",
  );
  assert.match(script, /-replace '\\\\','\/'/, "正则匹配反斜杠需要写成 '\\\\'");
  assert.match(script, /\.Replace\('\\','\/'\)/, "字面替换反斜杠写成 '\\'");
  assert.doesNotMatch(script, /ExecutionPolicy/, "内联脚本不依赖执行策略");
});

test("提权脚本排除安装器自身 pid（避免误杀自己）", () => {
  const script = buildElevatedKillScript({
    pids: [111, 222],
    pluginDirs: ["C:\\x\\plugins\\zcode-ide"],
    excludePids: [999],
  });
  assert.match(script, /\$exclude=@\(999\)/);
  assert.match(script, /exclude -notcontains \$id/, "按 pid 强杀时要跳过排除项");
  assert.match(script, /exclude -notcontains \$_\.ProcessId/, "按目录匹配时要跳过排除项");
});

test("EncodedCommand 是 UTF-16LE + base64，可被 PowerShell 还原", () => {
  const script = "Write-Output 'hi'";
  const encoded = encodePowerShellCommand(script);
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), script);
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
});
