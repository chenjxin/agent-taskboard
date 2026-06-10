import type { CommentKind, CommentRow, Severity } from '../../core/types.js';
import type { Db } from '../connection.js';

/** Reserved author for server-generated overlap notices. */
export const SYSTEM_AUTHOR = 'system';

export function insertComment(
  db: Db,
  taskId: string,
  authorAgentId: string,
  kind: CommentKind,
  body: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO comments (task_id, author_agent_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(taskId, authorAgentId, kind, body, now);
}

export function commentsByTask(db: Db, taskId: string): CommentRow[] {
  return db
    .prepare(`SELECT * FROM comments WHERE task_id = ? ORDER BY created_at, id`)
    .all(taskId) as CommentRow[];
}

/**
 * Heartbeat activity: others' comments on this task strictly after the previous heartbeat.
 * Strict '>' relies on cross-request ordering: a notice sharing the exact same
 * millisecond as the previous beat would be skipped. In practice the previous
 * beat and the notice always come from separate HTTP requests, so T_notice >
 * T_prev_beat holds; accepted as a documented invariant (single process, ms clock).
 */
export function commentsSince(
  db: Db,
  taskId: string,
  sinceMs: number,
  excludeAuthor: string,
): CommentRow[] {
  return db
    .prepare(
      `SELECT * FROM comments
       WHERE task_id = ? AND created_at > ? AND author_agent_id != ?
       ORDER BY created_at, id`,
    )
    .all(taskId, sinceMs, excludeAuthor) as CommentRow[];
}

export function countByTask(db: Db, taskId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE task_id = ?`).get(taskId) as {
    n: number;
  };
  return row.n;
}

/** Last 3 comments per task for the board, oldest first. */
export function recentByTask(db: Db, taskId: string, limit: number): CommentRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM comments WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(taskId, limit) as CommentRow[];
  return rows.reverse();
}

const NOTICE_FIRST_LINE = /^OVERLAP (HIGH|MEDIUM|UNKNOWN) task:(\S+)/;

/** Machine-readable first line of a system overlap notice (used for pair-dedup). */
export function noticeFirstLine(severity: Severity, counterpartTaskId: string): string {
  return `OVERLAP ${severity} task:${counterpartTaskId}`;
}

/**
 * Latest severity already noticed on `taskId` about `counterpartTaskId`, or null.
 * Re-notify only when the severity is new or has increased — otherwise iterating
 * on update_scope during negotiation (the canonical flow!) would spam both threads.
 */
export function latestNoticeSeverity(
  db: Db,
  taskId: string,
  counterpartTaskId: string,
): Severity | null {
  const rows = db
    .prepare(
      `SELECT body FROM comments
       WHERE task_id = ? AND kind = 'overlap_notice'
       ORDER BY created_at DESC, id DESC`,
    )
    .all(taskId) as Array<{ body: string }>;
  for (const { body } of rows) {
    const m = NOTICE_FIRST_LINE.exec(body);
    if (m && m[2] === counterpartTaskId) return m[1] as Severity;
  }
  return null;
}
