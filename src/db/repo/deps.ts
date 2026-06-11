import type { DepInfo, TaskDepRow } from '../../core/types.js';
import type { Db } from '../connection.js';

/** Full replacement — update_task semantics, mirroring replaceScopeRows. */
export function replaceDeps(db: Db, taskId: string, dependsOn: string[], now: number): void {
  db.prepare(`DELETE FROM task_deps WHERE task_id = ?`).run(taskId);
  const stmt = db.prepare(
    `INSERT INTO task_deps (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)`,
  );
  for (const dep of new Set(dependsOn)) stmt.run(taskId, dep, now);
}

/** Dependencies of one task, with enough context to judge them (title + status). */
export function depInfos(db: Db, taskId: string): DepInfo[] {
  return db
    .prepare(
      `SELECT t.id AS task_id, t.title, t.status FROM task_deps d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ? ORDER BY d.id`,
    )
    .all(taskId) as DepInfo[];
}

/** Dependencies for many tasks at once (list/board assembly). */
export function depInfosForTasks(db: Db, taskIds: string[]): Map<string, DepInfo[]> {
  const result = new Map<string, DepInfo[]>();
  if (taskIds.length === 0) return result;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT d.task_id AS for_task, t.id AS task_id, t.title, t.status FROM task_deps d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id IN (${placeholders}) ORDER BY d.id`,
    )
    .all(...taskIds) as Array<DepInfo & { for_task: string }>;
  for (const { for_task, ...info } of rows) {
    const list = result.get(for_task);
    if (list) list.push(info);
    else result.set(for_task, [info]);
  }
  return result;
}

/** Open tasks waiting on `taskId` (close fan-out + get_task dependents). */
export function dependentsOf(db: Db, taskId: string): DepInfo[] {
  return db
    .prepare(
      `SELECT t.id AS task_id, t.title, t.status FROM task_deps d
       JOIN tasks t ON t.id = d.task_id
       WHERE d.depends_on_task_id = ? ORDER BY d.id`,
    )
    .all(taskId) as DepInfo[];
}

/**
 * Would making `taskId` depend on each of `dependsOn` create a cycle?
 * BFS upstream from taskId's prospective deps; task counts are tiny.
 */
export function wouldCreateCycle(db: Db, taskId: string, dependsOn: string[]): string | null {
  const stmt = db.prepare(`SELECT depends_on_task_id FROM task_deps WHERE task_id = ?`) as {
    all: (id: string) => Array<{ depends_on_task_id: string }>;
  };
  for (const start of dependsOn) {
    const queue = [start];
    const seen = new Set<string>(queue);
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current === taskId) return start; // path start -> ... -> taskId exists
      for (const row of stmt.all(current)) {
        if (!seen.has(row.depends_on_task_id)) {
          seen.add(row.depends_on_task_id);
          queue.push(row.depends_on_task_id);
        }
      }
    }
  }
  return null;
}
