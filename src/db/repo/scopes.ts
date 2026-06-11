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

/**
 * Form metadata for the human bug-report page: every project on the board and
 * the modules its tasks have ever declared. Dropdowns instead of free text —
 * humans should pick from the vocabulary agents actually use, because a typed
 * module is what makes the bug routable (v1.7 related_backlog).
 */
export function reportMeta(db: Db): Array<{ project: string; modules: string[] }> {
  const projects = db
    .prepare(`SELECT DISTINCT project FROM tasks ORDER BY project`)
    .all() as Array<{ project: string }>;
  const mods = db
    .prepare(
      `SELECT DISTINCT t.project, s.module FROM scopes s
       JOIN tasks t ON t.id = s.task_id
       WHERE s.module IS NOT NULL ORDER BY t.project, s.module`,
    )
    .all() as Array<{ project: string; module: string }>;
  const byProject = new Map<string, string[]>(projects.map((p) => [p.project, []]));
  for (const m of mods) byProject.get(m.project)?.push(m.module);
  return [...byProject.entries()].map(([project, modules]) => ({ project, modules }));
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
