import type { Db } from '../connection.js';

export type FeedbackKind = 'bug' | 'friction' | 'idea' | 'praise';

export interface FeedbackRow {
  id: number;
  agent_id: string;
  kind: FeedbackKind;
  body: string;
  context: string | null;
  created_at: number;
}

export function insertFeedback(
  db: Db,
  agentId: string,
  kind: FeedbackKind,
  body: string,
  context: string | null,
  now: number,
): void {
  db.prepare(
    `INSERT INTO feedback (agent_id, kind, body, context, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(agentId, kind, body, context, now);
}

/** Operator view: newest first. */
export function allFeedback(db: Db, limit: number): FeedbackRow[] {
  return db
    .prepare(`SELECT * FROM feedback ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(limit) as FeedbackRow[];
}
