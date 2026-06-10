import type { Db } from '../connection.js';

/** Called at the top of EVERY tool handler — identity is self-reported, presence is telemetry. */
export function upsertAgent(db: Db, agentId: string, now: number): void {
  db.prepare(
    `INSERT INTO agents (agent_id, first_seen_at, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(agentId, now, now);
}
