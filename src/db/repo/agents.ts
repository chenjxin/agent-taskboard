import type { Db } from '../connection.js';

export interface AgentRow {
  agent_id: string;
  first_seen_at: number;
  last_seen_at: number;
}

/** Operator view (/admin/feedback): who uses the board, most recently active first. */
export function allAgents(db: Db): AgentRow[] {
  return db.prepare(`SELECT * FROM agents ORDER BY last_seen_at DESC`).all() as AgentRow[];
}

export function isKnownAgent(db: Db, agentId: string): boolean {
  return db.prepare(`SELECT 1 FROM agents WHERE agent_id = ?`).get(agentId) !== undefined;
}

export function allAgentIds(db: Db): string[] {
  return (db.prepare(`SELECT agent_id FROM agents`).all() as Array<{ agent_id: string }>).map(
    (r) => r.agent_id,
  );
}

/** Called at the top of EVERY tool handler — identity is self-reported, presence is telemetry. */
export function upsertAgent(db: Db, agentId: string, now: number): void {
  db.prepare(
    `INSERT INTO agents (agent_id, first_seen_at, last_seen_at) VALUES (?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).run(agentId, now, now);
}
