/**
 * 修复历史遗留的 workspace_key：把失效的 remote / 旧盘符键归一到当前工作区路径。
 *
 * 背景：migrate-tasks-to-local.cjs 把 host_id 改成 local 时，只更新了
 * workspace_identity / project_id / root_path，没有同步 workspace_key / workspace_path。
 * taskIndexRepo 的所有读写都以 workspace_key 为准（PRIMARY KEY (workspace_key, task_id)），
 * 于是这些任务仍通过 project join 显示在侧栏，但归档 / 置顶 / 已读会查不到行：
 *   - UI 报「归档任务失败」
 *   - zcode-task-index-syncer 撞 idx_tasks_host_task UNIQUE(host_id, task_id)
 *
 * 用法：
 *   node scripts/fix-task-workspace-keys.cjs --dry-run   # 只打印计划
 *   node scripts/fix-task-workspace-keys.cjs --apply     # 备份后执行
 */
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const mode = process.argv.includes("--apply") ? "apply" : "dry-run";
const dbPath = path.join(os.homedir(), ".zcode", "v2", "tasks-index.sqlite");

const SEP = "\\";
const ZCODE_IDE = `E:${SEP}gitee${SEP}zcode-ide`;
const EZLLM = `E:${SEP}gitee${SEP}ezllm`;

// 旧键 → 当前键 + 当前工作区路径。
const MAPPINGS = [
  {
    from: "remote:server:<host>:/E:/github/zcode-ide",
    toKey: ZCODE_IDE,
    toPath: ZCODE_IDE,
  },
  {
    from: `E:${SEP}github${SEP}zcode-ide`,
    toKey: ZCODE_IDE,
    toPath: ZCODE_IDE,
  },
  {
    from: "remote:server:<host>:/E:/work/ezllm",
    toKey: EZLLM,
    toPath: EZLLM,
  },
];

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout=15000"); // IDE 插件 server 可能同时在跑

const query = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

console.log(`模式: ${mode}  库: ${dbPath}`);

/** 统计每条映射会影响多少行，供 dry-run / apply 输出。 */
const plan = MAPPINGS.map((m) => {
  const tasks = one("SELECT COUNT(*) c FROM tasks WHERE workspace_key=?", m.from).c;
  const admissions = one(
    "SELECT COUNT(*) c FROM task_group_admissions WHERE workspace_key=?",
    m.from,
  ).c;
  const members = one("SELECT COUNT(*) c FROM task_group_members WHERE workspace_key=?", m.from).c;
  const nodeKey = JSON.stringify(m.from);
  const orders = db
    .prepare("SELECT COUNT(*) c FROM task_group_view_node_orders WHERE node_key LIKE ?")
    .get(`[${nodeKey},%`).c;
  return { ...m, tasks, admissions, members, orders };
});

for (const p of plan) {
  console.log(
    `${p.from}\n  → key=${p.toKey}  tasks=${p.tasks} admissions=${p.admissions} members=${p.members} viewOrders=${p.orders}`,
  );
}

const total = plan.reduce((n, p) => n + p.tasks, 0);
console.log(`\n合计待修任务行: ${total}`);
if (total === 0) {
  console.log("没有需要修复的行。");
  process.exit(0);
}

if (mode !== "apply") {
  console.log("（dry-run，未改动。加 --apply 执行）");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(os.homedir(), ".zcode", "backup", `tasks-index-fix-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  const src = dbPath + suffix;
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, "tasks-index.sqlite" + suffix));
}
console.log(`已备份到 ${backupDir}`);

const stats = { tasks: 0, admissions: 0, members: 0, orders: 0, dropped: 0 };

db.exec("BEGIN IMMEDIATE");
try {
  for (const p of plan) {
    // UNIQUE(host_id, task_id) 让同 task_id 不可能有两行；这里仍显式检查，
    // 避免未来索引变动后静默撞主键。
    const taskConflicts = query(
      "SELECT a.task_id FROM tasks a WHERE a.workspace_key=? AND EXISTS (SELECT 1 FROM tasks b WHERE b.task_id=a.task_id AND b.workspace_key=?)",
      p.from,
      p.toKey,
    );
    if (taskConflicts.length) {
      throw new Error(
        `tasks 冲突 ${taskConflicts.length} 条（task_id 已存在于 ${p.toKey}）: ${taskConflicts
          .slice(0, 5)
          .map((r) => r.task_id)
          .join(", ")}`,
      );
    }
    stats.tasks += db
      .prepare("UPDATE tasks SET workspace_key=?, workspace_path=? WHERE workspace_key=?")
      .run(p.toKey, p.toPath, p.from).changes;

    // 组织态附表的 PK 同样是 (workspace_key, task_id)：目标键已登记的行优先，
    // 旧键里的重复登记直接丢弃，否则 UPDATE 会撞主键。
    const admissionDup = db
      .prepare(
        "DELETE FROM task_group_admissions WHERE workspace_key=? AND task_id IN (SELECT task_id FROM task_group_admissions WHERE workspace_key=?)",
      )
      .run(p.from, p.toKey);
    stats.dropped += admissionDup.changes;
    stats.admissions += db
      .prepare("UPDATE task_group_admissions SET workspace_key=? WHERE workspace_key=?")
      .run(p.toKey, p.from).changes;

    const memberDup = db
      .prepare(
        "DELETE FROM task_group_members WHERE workspace_key=? AND task_id IN (SELECT task_id FROM task_group_members WHERE workspace_key=?)",
      )
      .run(p.from, p.toKey);
    stats.dropped += memberDup.changes;
    stats.members += db
      .prepare(
        "UPDATE task_group_members SET workspace_key=?, workspace_path=? WHERE workspace_key=?",
      )
      .run(p.toKey, p.toPath, p.from).changes;

    // 视图排序键形如 ["<workspaceKey>","<taskId>"]，跟着主键一起搬。
    const fromPrefix = `[${JSON.stringify(p.from)},`;
    const toPrefix = `[${JSON.stringify(p.toKey)},`;
    const orderRows = query(
      "SELECT node_key FROM task_group_view_node_orders WHERE node_type='task' AND node_key LIKE ?",
      `${fromPrefix}%`,
    );
    for (const row of orderRows) {
      const next = toPrefix + row.node_key.slice(fromPrefix.length);
      const exists = db
        .prepare(
          "SELECT 1 AS hit FROM task_group_view_node_orders WHERE node_type='task' AND node_key=?",
        )
        .get(next);
      if (exists) {
        db.prepare(
          "DELETE FROM task_group_view_node_orders WHERE node_type='task' AND node_key=?",
        ).run(row.node_key);
        stats.dropped += 1;
        continue;
      }
      db.prepare(
        "UPDATE task_group_view_node_orders SET node_key=? WHERE node_type='task' AND node_key=?",
      ).run(next, row.node_key);
      stats.orders += 1;
    }
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  console.error("修复失败已回滚:", error);
  process.exit(1);
}

console.log("完成:", stats);
console.log("\n剩余非路径形态的 workspace_key:");
const left = query(
  "SELECT workspace_key, COUNT(*) c FROM tasks WHERE workspace_key LIKE 'remote:%' GROUP BY workspace_key",
);
console.log(left.length ? left : "（无）");
