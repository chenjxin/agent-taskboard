import type { TaskRow, TaskStatus } from '../../core/types.js';
import type { Db } from '../connection.js';

export function insertTask(db: Db, task: TaskRow): void {
  db.prepare(
    `INSERT INTO tasks (id, project, title, description, branch, owner_agent_id, created_by_agent_id,
                        status, type, severity, iteration, waiting_on, closing_note, created_at, updated_at, claimed_at, fixed_at, closed_at, last_heartbeat_at)
     VALUES (@id, @project, @title, @description, @branch, @owner_agent_id, @created_by_agent_id,
             @status, @type, @severity, @iteration, @waiting_on, @closing_note, @created_at, @updated_at, @claimed_at, @fixed_at, @closed_at, @last_heartbeat_at)`,
  ).run(task);
}

export function getTask(db: Db, id: string): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
}

export type StatusFilter = TaskStatus | 'open' | 'all';

export interface ListTasksFilters {
  project?: string | undefined;
  /** 'open' = planned + active + waiting + fixed (not yet verified/closed). */
  status?: StatusFilter | undefined;
  ownerAgentId?: string | undefined;
  createdByAgentId?: string | undefined;
  type?: string | undefined;
  iteration?: string | undefined;
  limit: number;
}

export function listTasks(db: Db, filters: ListTasksFilters): TaskRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: filters.limit };
  if (filters.project) {
    where.push('project = @project');
    params['project'] = filters.project;
  }
  const status = filters.status ?? 'open';
  if (status === 'open') {
    where.push(`status IN ('planned', 'active', 'waiting', 'fixed')`);
  } else if (status !== 'all') {
    where.push('status = @status');
    params['status'] = status;
  }
  if (filters.ownerAgentId) {
    where.push('owner_agent_id = @owner');
    params['owner'] = filters.ownerAgentId;
  }
  if (filters.createdByAgentId) {
    where.push('created_by_agent_id = @createdBy');
    params['createdBy'] = filters.createdByAgentId;
  }
  if (filters.type) {
    where.push('type = @type');
    params['type'] = filters.type;
  }
  if (filters.iteration) {
    where.push('iteration = @iteration');
    params['iteration'] = filters.iteration;
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM tasks ${whereSql} ORDER BY updated_at DESC LIMIT @limit`)
    .all(params) as TaskRow[];
}

/**
 * The overlap-counterpart pool: same-project planned+active+waiting tasks,
 * excluding the caller's own. Deliberately NARROWER than the 'open' display
 * filter: 'fixed' work is finished code awaiting verification, not contested
 * ground — but 'waiting' work is merely paused and still holds its scope.
 */
export function overlapPoolTasks(db: Db, project: string, excludeTaskId?: string): TaskRow[] {
  return db
    .prepare(
      `SELECT * FROM tasks WHERE project = ? AND status IN ('planned', 'active', 'waiting') AND id != ? ORDER BY created_at`,
    )
    .all(project, excludeTaskId ?? '') as TaskRow[];
}

/** Distinct project slugs with open tasks (for did-you-mean warnings). */
export function distinctOpenProjects(db: Db): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT project FROM tasks WHERE status IN ('planned', 'active', 'waiting')`)
    .all() as Array<{ project: string }>;
  return rows.map((r) => r.project);
}

/** Recently relevant tasks for the board/standup: open (incl. awaiting verification) + closed within `closedSinceMs`. */
export function boardTasks(db: Db, closedSinceMs: number, limit: number): TaskRow[] {
  return db
    .prepare(
      `SELECT * FROM tasks WHERE status IN ('planned', 'active', 'waiting', 'fixed') OR closed_at >= ?
       ORDER BY project, created_at LIMIT ?`,
    )
    .all(closedSinceMs, limit) as TaskRow[];
}

/**
 * active -> waiting: paused on an external condition. waiting_on records WHAT
 * (the whole point — standup readers see why no progress is expected).
 * Guarded UPDATE: returns false when the task is not currently active.
 */
export function setWaiting(db: Db, id: string, waitingOn: string, now: number): boolean {
  return (
    db
      .prepare(
        `UPDATE tasks SET status = 'waiting', waiting_on = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(waitingOn, now, id).changes > 0
  );
}

/** waiting -> active: the external condition resolved; waiting_on is cleared. */
export function resumeFromWaiting(db: Db, id: string, now: number): boolean {
  return (
    db
      .prepare(
        `UPDATE tasks SET status = 'active', waiting_on = NULL, updated_at = ?, last_heartbeat_at = ?
         WHERE id = ? AND status = 'waiting'`,
      )
      .run(now, now, id).changes > 0
  );
}

/** Guarded close: only not-yet-closed rows transition. Returns false if a concurrent writer won. */
export function setStatus(
  db: Db,
  id: string,
  status: 'done' | 'abandoned',
  closingNote: string,
  now: number,
): boolean {
  const info = db
    .prepare(
      `UPDATE tasks SET status = ?, closing_note = ?, closed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('planned', 'active', 'waiting', 'fixed')`,
    )
    .run(status, closingNote, now, now, id);
  return info.changes === 1;
}

/**
 * Bug verification lifecycle transitions, each guarded in SQL — the web verify
 * endpoint makes a second writer a real possibility. 'fixed' deliberately does
 * NOT touch closed_at (standup/board treat closed_at as terminal).
 */
export function markBugFixed(db: Db, id: string, now: number): boolean {
  const info = db
    .prepare(
      `UPDATE tasks SET status = 'fixed', fixed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND type = 'bug'`,
    )
    .run(now, now, id);
  return info.changes === 1;
}

/**
 * verify_fail: back to the fixer (owner unchanged); heartbeat reset so it is
 * not instantly stale. The cursor lands 1ms BEFORE `now` — the rejection
 * comment is written at `now` in the same transaction, and the heartbeat
 * activity query uses strict '>', so an equal timestamp would swallow the very
 * notification this transition exists to deliver.
 */
export function reopenBug(db: Db, id: string, now: number): boolean {
  const info = db
    .prepare(
      `UPDATE tasks SET status = 'active', fixed_at = NULL, last_heartbeat_at = ? - 1, updated_at = ?
       WHERE id = ? AND status = 'fixed' AND type = 'bug'`,
    )
    .run(now, now, id);
  return info.changes === 1;
}

/**
 * Guarded claim: succeeds only while the task is still planned and either
 * unowned or already the caller's. Returns false when someone won the race
 * (structurally serialized in-process, but a second process could exist).
 */
export function claimTask(db: Db, id: string, agentId: string, now: number): boolean {
  const info = db
    .prepare(
      `UPDATE tasks SET owner_agent_id = @agent, status = 'active', claimed_at = @now,
                        last_heartbeat_at = @now, updated_at = @now
       WHERE id = @id AND status = 'planned' AND (owner_agent_id IS NULL OR owner_agent_id = @agent)`,
    )
    .run({ id, agent: agentId, now });
  return info.changes === 1;
}

export interface TaskPatch {
  title?: string | undefined;
  description?: string | undefined;
  branch?: string | null | undefined;
  iteration?: string | null | undefined;
  severity?: string | null | undefined;
}

export function patchTask(db: Db, id: string, patch: TaskPatch, now: number): void {
  const sets: string[] = ['updated_at = @now'];
  const params: Record<string, unknown> = { id, now };
  for (const key of ['title', 'description', 'branch', 'iteration', 'severity'] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = patch[key];
    }
  }
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function touchHeartbeat(db: Db, id: string, now: number): void {
  db.prepare(`UPDATE tasks SET last_heartbeat_at = ? WHERE id = ?`).run(now, id);
}

export function touchUpdated(db: Db, id: string, now: number): void {
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, id);
}

/** Existence probe for dependency validation: returns the ids that do NOT exist. */
export function missingTaskIds(db: Db, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const found = new Set(
    (db.prepare(`SELECT id FROM tasks WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );
  return ids.filter((id) => !found.has(id));
}
