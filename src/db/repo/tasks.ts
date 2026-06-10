import type { TaskRow, TaskStatus } from '../../core/types.js';
import type { Db } from '../connection.js';

export function insertTask(db: Db, task: TaskRow): void {
  db.prepare(
    `INSERT INTO tasks (id, project, title, description, branch, owner_agent_id, status,
                        closing_note, created_at, updated_at, closed_at, last_heartbeat_at)
     VALUES (@id, @project, @title, @description, @branch, @owner_agent_id, @status,
             @closing_note, @created_at, @updated_at, @closed_at, @last_heartbeat_at)`,
  ).run(task);
}

export function getTask(db: Db, id: string): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
}

export interface ListTasksFilters {
  project?: string | undefined;
  status?: TaskStatus | 'all' | undefined;
  ownerAgentId?: string | undefined;
  limit: number;
}

export function listTasks(db: Db, filters: ListTasksFilters): TaskRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: filters.limit };
  if (filters.project) {
    where.push('project = @project');
    params['project'] = filters.project;
  }
  const status = filters.status ?? 'active';
  if (status !== 'all') {
    where.push('status = @status');
    params['status'] = status;
  }
  if (filters.ownerAgentId) {
    where.push('owner_agent_id = @owner');
    params['owner'] = filters.ownerAgentId;
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM tasks ${whereSql} ORDER BY updated_at DESC LIMIT @limit`)
    .all(params) as TaskRow[];
}

/** The overlap-counterpart pool: same-project active tasks, excluding the caller's own. */
export function activeTasksInProject(db: Db, project: string, excludeTaskId?: string): TaskRow[] {
  return db
    .prepare(
      `SELECT * FROM tasks WHERE project = ? AND status = 'active' AND id != ? ORDER BY created_at`,
    )
    .all(project, excludeTaskId ?? '') as TaskRow[];
}

/** Distinct project slugs with at least one active task (for did-you-mean warnings). */
export function distinctActiveProjects(db: Db): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT project FROM tasks WHERE status = 'active'`)
    .all() as Array<{ project: string }>;
  return rows.map((r) => r.project);
}

/** Recently relevant tasks for the human board: active + closed within `closedSinceMs`. */
export function boardTasks(db: Db, closedSinceMs: number, limit: number): TaskRow[] {
  return db
    .prepare(
      `SELECT * FROM tasks WHERE status = 'active' OR closed_at >= ? ORDER BY project, created_at LIMIT ?`,
    )
    .all(closedSinceMs, limit) as TaskRow[];
}

export function setStatus(
  db: Db,
  id: string,
  status: 'done' | 'abandoned',
  closingNote: string,
  now: number,
): void {
  db.prepare(
    `UPDATE tasks SET status = ?, closing_note = ?, closed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(status, closingNote, now, now, id);
}

export function touchHeartbeat(db: Db, id: string, now: number): void {
  db.prepare(`UPDATE tasks SET last_heartbeat_at = ? WHERE id = ?`).run(now, id);
}

export function touchUpdated(db: Db, id: string, now: number): void {
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, id);
}
