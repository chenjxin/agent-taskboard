/**
 * Information-tier bug routing: which unclaimed backlog bugs sit on an agent's
 * turf? Turf = scopes of tasks the agent has owned (ANY status — history
 * included; you broke it / you built it is exactly the signal). Routing only
 * ever INFORMS: the result rides pull surfaces (SessionStart payload,
 * heartbeat), the agent asks its human, the human decides. Never assigns.
 */
import { scopesTouch } from '../../core/overlap.js';
import type { ScopeRow, TaskRow } from '../../core/types.js';
import type { Db } from '../connection.js';
import { scopesByTasks } from './scopes.js';

export interface RelatedBacklogBug {
  task_id: string;
  title: string;
  project: string;
  severity: string | null;
  created_by_agent_id: string;
  created_at: number;
  /** HIGH = path-glob contact, MEDIUM = module contact. */
  match: 'HIGH' | 'MEDIUM';
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const CAP = 5;

function unclaimedBacklogBugs(db: Db): TaskRow[] {
  // Recency-biased cut BEFORE ranking: bugs beyond the 100 newest never route.
  // Deliberate — routing is a freshness heuristic, not an inventory (standup
  // and the board carry the full backlog), and this cap is what bounds the
  // glob-matching fan-out on the heartbeat hot path. Raise with care.
  return db
    .prepare(
      `SELECT * FROM tasks
       WHERE status = 'planned' AND owner_agent_id IS NULL AND type = 'bug'
       ORDER BY created_at DESC LIMIT 100`,
    )
    .all() as TaskRow[];
}

function rank(bugs: RelatedBacklogBug[]): RelatedBacklogBug[] {
  return bugs
    .sort(
      (a, b) =>
        (a.match === b.match ? 0 : a.match === 'HIGH' ? -1 : 1) ||
        (SEVERITY_ORDER[a.severity ?? ''] ?? 9) - (SEVERITY_ORDER[b.severity ?? ''] ?? 9) ||
        b.created_at - a.created_at,
    )
    .slice(0, CAP);
}

function matchAgainst(db: Db, bugs: TaskRow[], turf: Map<string, ScopeRow[]>): RelatedBacklogBug[] {
  const bugScopes = scopesByTasks(db, bugs.map((b) => b.id));
  const out: RelatedBacklogBug[] = [];
  for (const bug of bugs) {
    if (!turf.has(bug.project)) continue;
    const mine = turf.get(bug.project) ?? [];
    const match = scopesTouch(mine, bugScopes.get(bug.id) ?? []);
    if (match === null) continue;
    out.push({
      task_id: bug.id,
      title: bug.title,
      project: bug.project,
      severity: bug.severity,
      created_by_agent_id: bug.created_by_agent_id,
      created_at: bug.created_at,
      match,
    });
  }
  return rank(out);
}

/** Backlog bugs overlapping ANY scope the agent has ever declared (per project). */
export function relatedBacklogForAgent(db: Db, agentId: string): RelatedBacklogBug[] {
  // Turf = the 200 most recent owned tasks: bounds the scope merge for
  // long-tenured agents, and stale turf SHOULD age out — code someone touched
  // 500 tasks ago is no longer meaningfully theirs.
  const myTasks = db
    .prepare(`SELECT id, project FROM tasks WHERE owner_agent_id = ? ORDER BY created_at DESC LIMIT 200`)
    .all(agentId) as Array<{ id: string; project: string }>;
  if (myTasks.length === 0) return [];
  const scopeRows = scopesByTasks(db, myTasks.map((t) => t.id));
  const turf = new Map<string, ScopeRow[]>();
  for (const t of myTasks) {
    const rows = scopeRows.get(t.id) ?? [];
    if (rows.length === 0) continue;
    turf.set(t.project, [...(turf.get(t.project) ?? []), ...rows]);
  }
  if (turf.size === 0) return [];
  return matchAgainst(db, unclaimedBacklogBugs(db), turf);
}

/** Backlog bugs overlapping ONE task's scope (heartbeat surface: "on this turf, right now"). */
export function relatedBacklogForTask(db: Db, task: TaskRow): RelatedBacklogBug[] {
  const scope = scopesByTasks(db, [task.id]).get(task.id) ?? [];
  if (scope.length === 0) return [];
  return matchAgainst(db, unclaimedBacklogBugs(db), new Map([[task.project, scope]]));
}
