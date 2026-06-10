import type { ScopeRow, ScopeRowInput } from '../../core/types.js';
import type { Db } from '../connection.js';

export function insertScopeRows(db: Db, taskId: string, rows: ScopeRowInput[]): void {
  const stmt = db.prepare(
    `INSERT INTO scopes (task_id, path_glob, module, note) VALUES (?, ?, ?, ?)`,
  );
  for (const row of rows) {
    stmt.run(taskId, row.path_glob ?? null, row.module ?? null, row.note ?? null);
  }
}

/** Full replacement — update_scope semantics. */
export function replaceScopeRows(db: Db, taskId: string, rows: ScopeRowInput[]): void {
  db.prepare(`DELETE FROM scopes WHERE task_id = ?`).run(taskId);
  insertScopeRows(db, taskId, rows);
}

export function scopesByTask(db: Db, taskId: string): ScopeRow[] {
  return db.prepare(`SELECT * FROM scopes WHERE task_id = ? ORDER BY id`).all(taskId) as ScopeRow[];
}

/** Scope rows for many tasks at once (overlap pool, board assembly). */
export function scopesByTasks(db: Db, taskIds: string[]): Map<string, ScopeRow[]> {
  const result = new Map<string, ScopeRow[]>();
  if (taskIds.length === 0) return result;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM scopes WHERE task_id IN (${placeholders}) ORDER BY id`)
    .all(...taskIds) as ScopeRow[];
  for (const row of rows) {
    const list = result.get(row.task_id);
    if (list) list.push(row);
    else result.set(row.task_id, [row]);
  }
  return result;
}
