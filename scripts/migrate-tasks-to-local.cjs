/**
 * 一次性迁移：把 remote:server:* 宿主的历史会话/项目合并到 local 宿主。
 *
 * 前置条件：插件 server 已改为 local 形态（否则迁移完 UI 仍按 remote 身份过滤）。
 * 执行前必须关闭桌面客户端与 IDE 插件的 server 进程（SQLite 写冲突）。
 *
 * 用法：
 *   node zcode-migrate-remote-to-local.cjs --dry-run   # 只打印计划
 *   node zcode-migrate-remote-to-local.cjs --apply     # 备份后执行
 */
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("path"), os = require("os");

const mode = process.argv.includes("--apply") ? "apply" : "dry-run";
const dbPath = path.join(os.homedir(), ".zcode", "v2", "tasks-index.sqlite");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout=15000"); // IDE 插件 server 可能同时在跑，写锁等待而非立即报错

const REMOTE_HOST = "remote:server:<host>";

// 源项目 → local 目标项目的合并映射（合并后源项目行软删除）
// - 49a6f8cd/2faf908e：remote:server:<host> 形态遗留的 remote 项目
// - da73eac7（"zcode-ide (2)"）：local 重复项目（与 79b0880c 同 root），web-ide 复用时命中它导致任务分散
// local/zcode-ide = 79b0880c...（root E:\work\zcode-ide），local/ezllm = a5d447e9...（root E:\work\ezllm）
const MERGE = [
  { sourceProject: "49a6f8cd-8a60-476a-89eb-af4399957936", localProject: "79b0880c-fd65-498d-8782-06e6c24bc4ec", oldRoot: "E:\\github\\zcode-ide", newRoot: "E:\\gitee\\zcode-ide" },
  { sourceProject: "2faf908e-b820-432c-85d7-7db735601d5b", localProject: "a5d447e9-d330-49e4-bc7a-06c83771cd44", oldRoot: null, newRoot: null },
  { sourceProject: "da73eac7-e3da-46c5-99a9-b9f6857dd4b5", localProject: "79b0880c-fd65-498d-8782-06e6c24bc4ec", oldRoot: null, newRoot: null },
];

console.log(`模式: ${mode}  库: ${dbPath}`);
const count = (sql, ...args) => db.prepare(sql).get(...args).c;
console.log(`remote 任务: ${count("SELECT COUNT(*) c FROM tasks WHERE host_id=?", REMOTE_HOST)} 条`);

if (mode === "apply") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(os.homedir(), ".zcode", "backup", `tasks-index-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = dbPath + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, "tasks-index.sqlite" + suffix));
  }
  console.log(`已备份到 ${backupDir}`);
  db.exec("BEGIN");
  try {
    // 同一 task_id 在 local 下已有行（且实测更新更晚）时，remote 行是陈旧副本，直接删除
    // 避免 (host_id, task_id) 唯一键冲突。实测 5 条：local 行 updated_at 全部晚于 remote 行。
    const dup = db.prepare(`SELECT task_id FROM tasks WHERE host_id=?
      INTERSECT SELECT task_id FROM tasks WHERE host_id='local'`).all(REMOTE_HOST);
    if (dup.length) {
      const ph = dup.map(() => "?").join(",");
      const del = db.prepare(`DELETE FROM tasks WHERE host_id=? AND task_id IN (${ph})`).run(REMOTE_HOST, ...dup.map(d => d.task_id));
      console.log(`删除 ${del.changes} 条与 local 行重复的 remote 副本（local 行更新，保留之）`);
    }
    // workspace_key 是 taskIndexRepo 的主键（PRIMARY KEY (workspace_key, task_id)），
    // 只改 host_id 会留下 remote identity / 旧盘符键：侧栏靠 project join 仍能显示任务，
    // 但归档、置顶、已读都查不到行（UI 报「归档任务失败」），syncer 还会撞 (host_id, task_id) 唯一索引。
    for (const row of db.prepare("SELECT rowid, workspace_key FROM tasks WHERE workspace_key LIKE 'remote:server:%'").all()) {
      const asPath = row.workspace_key
        .replace(/^remote:server:[^:]+:/, "")
        .replace(/^\//, "")
        .replace(/\//g, "\\");
      db.prepare("UPDATE tasks SET workspace_key=?, workspace_path=? WHERE rowid=?").run(asPath, asPath, row.rowid);
      console.log(`workspace_key ${row.workspace_key} → ${asPath}`);
    }
    for (const m of MERGE) {
      const moved = db.prepare("UPDATE tasks SET host_id='local', project_id=?, workspace_identity=NULL WHERE (host_id=? AND project_id=?) OR project_id=?").run(m.localProject, REMOTE_HOST, m.sourceProject, m.sourceProject);
      console.log(`项目 ${m.sourceProject} → ${m.localProject}: 迁移 ${moved.changes} 条任务`);
      if (m.oldRoot) {
        const rooted = db.prepare("UPDATE tasks SET root_path=? WHERE root_path=? AND project_id=?").run(m.newRoot, m.oldRoot, m.localProject);
        console.log(`root_path ${m.oldRoot} → ${m.newRoot}: ${rooted.changes} 条`);
        const rekeyed = db.prepare("UPDATE tasks SET workspace_key=?, workspace_path=? WHERE workspace_key=? OR workspace_path=?").run(m.newRoot, m.newRoot, m.oldRoot, m.oldRoot);
        console.log(`workspace_key/path ${m.oldRoot} → ${m.newRoot}: ${rekeyed.changes} 条（组织态附表用 fix-task-workspace-keys.cjs 兜底）`);
      }
      // 源项目行软删除，避免与 local 目标项目并列显示
      db.prepare("UPDATE projects SET deleted=1, deleted_at=? WHERE project_id=?").run(Date.now(), m.sourceProject);
    }
    db.exec("COMMIT");
    console.log("迁移完成。剩余 remote 任务:", count("SELECT COUNT(*) c FROM tasks WHERE host_id=?", REMOTE_HOST));
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("迁移失败已回滚:", e);
    process.exit(1);
  }
} else {
  for (const m of MERGE) {
    const n = count("SELECT COUNT(*) c FROM tasks WHERE (host_id=? AND project_id=?) OR project_id=?", REMOTE_HOST, m.sourceProject, m.sourceProject);
    console.log(`将把项目 ${m.sourceProject} 的 ${n} 条任务并入 ${m.localProject}${m.oldRoot ? `，root_path ${m.oldRoot} → ${m.newRoot}` : ""}，源项目行软删除`);
  }
  console.log("（dry-run，未改动。加 --apply 执行）");
}
