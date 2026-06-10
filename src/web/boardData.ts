import { isBroadGlob } from '../core/globs.js';
import { hoursSince, isStale } from '../core/staleness.js';
import type { CommentKind, TaskStatus } from '../core/types.js';
import type { Db } from '../db/connection.js';
import { countByTask, recentByTask } from '../db/repo/comments.js';
import { scopesByTasks } from '../db/repo/scopes.js';
import { boardTasks, listTasks } from '../db/repo/tasks.js';

const CLOSED_WINDOW_MS = 7 * 24 * 3_600_000;
const ROW_CAP = 500;

export interface BoardQuery {
  project?: string | undefined;
  owner?: string | undefined;
  status?: string | undefined;
}

export interface BoardTask {
  id: string;
  title: string;
  owner_agent_id: string;
  branch: string | null;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  closing_note: string | null;
  last_heartbeat_at: number;
  stale: boolean;
  hours_since_heartbeat: number;
  scopes: Array<{ path_glob: string | null; module: string | null; note: string | null }>;
  broad_glob: boolean;
  recent_comments: Array<{ author_agent_id: string; kind: CommentKind; body: string; created_at: number }>;
  comment_count: number;
}

export interface BoardPayload {
  generated_at: number;
  stale_ttl_hours: number;
  projects: Array<{ project: string; tasks: BoardTask[] }>;
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
    status === 'active' || status === 'done' || status === 'abandoned' || status === 'all'
      ? listTasks(db, { status, limit: ROW_CAP })
      : boardTasks(db, now - CLOSED_WINDOW_MS, ROW_CAP); // default: active + recently closed
  if (query.project) rows = rows.filter((t) => t.project === query.project);
  if (query.owner) rows = rows.filter((t) => t.owner_agent_id === query.owner);

  const scopeMap = scopesByTasks(
    db,
    rows.map((t) => t.id),
  );

  const byProject = new Map<string, BoardTask[]>();
  for (const t of rows) {
    const scopes = (scopeMap.get(t.id) ?? []).map((s) => ({
      path_glob: s.path_glob,
      module: s.module,
      note: s.note,
    }));
    const task: BoardTask = {
      id: t.id,
      title: t.title,
      owner_agent_id: t.owner_agent_id,
      branch: t.branch,
      status: t.status,
      created_at: t.created_at,
      updated_at: t.updated_at,
      closed_at: t.closed_at,
      closing_note: t.closing_note,
      last_heartbeat_at: t.last_heartbeat_at,
      stale: t.status === 'active' && isStale(t.last_heartbeat_at, staleTtlHours, now),
      hours_since_heartbeat: hoursSince(t.last_heartbeat_at, now),
      scopes,
      broad_glob: scopes.some((s) => s.path_glob !== null && isBroadGlob(s.path_glob)),
      recent_comments: recentByTask(db, t.id, 3).map((c) => ({
        author_agent_id: c.author_agent_id,
        kind: c.kind,
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
    generated_at: now,
    stale_ttl_hours: staleTtlHours,
    projects: [...byProject.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([project, tasks]) => ({ project, tasks })),
  };
}
