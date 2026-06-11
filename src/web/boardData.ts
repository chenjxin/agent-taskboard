import { isBroadGlob } from '../core/globs.js';
import { hoursSince, isStale } from '../core/staleness.js';
import { blockingDeps } from '../core/standup.js';
import type { BugSeverity, CommentKind, DepInfo, TaskStatus, TaskType } from '../core/types.js';
import type { Db } from '../db/connection.js';
import { countByTask, recentByTask } from '../db/repo/comments.js';
import { depInfosForTasks } from '../db/repo/deps.js';
import { scopesByTasks } from '../db/repo/scopes.js';
import { boardTasks, listTasks, type StatusFilter } from '../db/repo/tasks.js';

const CLOSED_WINDOW_MS = 7 * 24 * 3_600_000;
const ROW_CAP = 500;

/** Rides into teammates' agent context via the SessionStart hook (raw JSON dump). */
const PROTOCOL_HINT =
  "Board protocol v3: tasks may be 'planned', including unowned backlog items (owner null) — claim_task before working on one; bugs are type='bug' tasks with a verification lifecycle (fix_ready -> fixed/待回归 -> verify_pass|verify_fail via update_bug_state); check_overlap covers planned tasks; get_standup returns a 24h digest incl. awaiting_verification; closing a task auto-notifies dependents. The board has a backlog but never assigns work.";

export interface BoardQuery {
  project?: string | undefined;
  owner?: string | undefined;
  status?: string | undefined;
}

export interface BoardTask {
  id: string;
  title: string;
  owner_agent_id: string | null;
  branch: string | null;
  status: TaskStatus;
  type: TaskType;
  severity: BugSeverity | null;
  fixed_at: number | null;
  iteration: string | null;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  closed_at: number | null;
  closing_note: string | null;
  last_heartbeat_at: number;
  stale: boolean;
  hours_since_heartbeat: number;
  scopes: Array<{ path_glob: string | null; module: string | null; note: string | null }>;
  broad_glob: boolean;
  depends_on: DepInfo[];
  blocked: boolean;
  recent_comments: Array<{ author_agent_id: string; kind: CommentKind; urgent: number; body: string; created_at: number }>;
  comment_count: number;
}

export interface IterationStat {
  iteration: string;
  total: number;
  planned: number;
  active: number;
  fixed: number;
  done: number;
  abandoned: number;
  /** Average created->closed hours across done tasks, null until one finishes. */
  avg_cycle_hours: number | null;
}

export interface BoardPayload {
  protocol_version: number;
  protocol_hint: string;
  generated_at: number;
  stale_ttl_hours: number;
  projects: Array<{ project: string; iterations: IterationStat[]; tasks: BoardTask[] }>;
}

const STATUS_FILTERS = new Set(['planned', 'active', 'fixed', 'done', 'abandoned', 'all', 'open']);

function iterationStats(tasks: BoardTask[]): IterationStat[] {
  const byIteration = new Map<string, BoardTask[]>();
  for (const t of tasks) {
    if (t.iteration === null) continue;
    const list = byIteration.get(t.iteration);
    if (list) list.push(t);
    else byIteration.set(t.iteration, [t]);
  }
  return [...byIteration.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([iteration, rows]) => {
      const done = rows.filter((t) => t.status === 'done');
      const cycles = done
        .filter((t) => t.closed_at !== null)
        .map((t) => ((t.closed_at as number) - t.created_at) / 3_600_000);
      return {
        iteration,
        total: rows.length,
        planned: rows.filter((t) => t.status === 'planned').length,
        active: rows.filter((t) => t.status === 'active').length,
        fixed: rows.filter((t) => t.status === 'fixed').length,
        done: done.length,
        abandoned: rows.filter((t) => t.status === 'abandoned').length,
        avg_cycle_hours:
          cycles.length > 0
            ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 10) / 10
            : null,
      };
    });
}

/** Pure assembly of the /api/board payload (also consumed by the adoption-kit SessionStart hook). */
export function buildBoardData(
  db: Db,
  staleTtlHours: number,
  now: number,
  query: BoardQuery,
): BoardPayload {
  const status = query.status;
  let rows =
    status !== undefined && STATUS_FILTERS.has(status)
      ? listTasks(db, { status: status as StatusFilter, limit: ROW_CAP })
      : boardTasks(db, now - CLOSED_WINDOW_MS, ROW_CAP); // default: open + recently closed
  if (query.project) rows = rows.filter((t) => t.project === query.project);
  if (query.owner) rows = rows.filter((t) => t.owner_agent_id === query.owner);

  const ids = rows.map((t) => t.id);
  const scopeMap = scopesByTasks(db, ids);
  const depsMap = depInfosForTasks(db, ids);

  const byProject = new Map<string, BoardTask[]>();
  for (const t of rows) {
    const scopes = (scopeMap.get(t.id) ?? []).map((s) => ({
      path_glob: s.path_glob,
      module: s.module,
      note: s.note,
    }));
    const taskDeps = depsMap.get(t.id) ?? [];
    const task: BoardTask = {
      id: t.id,
      title: t.title,
      owner_agent_id: t.owner_agent_id,
      branch: t.branch,
      status: t.status,
      type: t.type,
      severity: t.severity,
      fixed_at: t.fixed_at,
      iteration: t.iteration,
      created_at: t.created_at,
      updated_at: t.updated_at,
      claimed_at: t.claimed_at,
      closed_at: t.closed_at,
      closing_note: t.closing_note,
      last_heartbeat_at: t.last_heartbeat_at,
      stale: t.status === 'active' && isStale(t.last_heartbeat_at, staleTtlHours, now),
      hours_since_heartbeat: hoursSince(t.last_heartbeat_at, now),
      scopes,
      broad_glob: scopes.some((s) => s.path_glob !== null && isBroadGlob(s.path_glob)),
      depends_on: taskDeps,
      blocked: blockingDeps(taskDeps).length > 0,
      recent_comments: recentByTask(db, t.id, 3).map((c) => ({
        author_agent_id: c.author_agent_id,
        kind: c.kind,
        urgent: c.urgent,
        body: c.body,
        created_at: c.created_at,
      })),
      comment_count: countByTask(db, t.id),
    };
    const list = byProject.get(t.project);
    if (list) list.push(task);
    else byProject.set(t.project, [task]);
  }

  return {
    protocol_version: 3,
    protocol_hint: PROTOCOL_HINT,
    generated_at: now,
    stale_ttl_hours: staleTtlHours,
    projects: [...byProject.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([project, tasks]) => ({ project, iterations: iterationStats(tasks), tasks })),
  };
}
