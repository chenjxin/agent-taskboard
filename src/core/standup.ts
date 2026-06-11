/**
 * Standup digest: pure classification over pre-fetched rows. The async-standup
 * answer to "过去 24h 这个项目发生了什么" — completed/started/planned/blocked/
 * stale at a glance, for agents at task receipt and humans on the board.
 */
import { isStale } from './staleness.js';
import type { DepInfo, TaskRow } from './types.js';

export interface StandupTaskRef {
  task_id: string;
  title: string;
  project: string;
  owner_agent_id: string | null;
  iteration: string | null;
  type: string;
  severity: string | null;
  /** Present only on blocked[] rows: the deps that still hold this task up. */
  blocked_by?: string[];
}

/**
 * NOW-fact inventory of an iteration: everything still open, regardless of the
 * time window. Without this, a week plan registered on Monday "vanishes" from
 * standup by Wednesday even though the planned items are all still open.
 */
export interface IterationStock {
  iteration: string;
  planned: StandupTaskRef[];
  active: StandupTaskRef[];
  fixed: StandupTaskRef[];
}

export interface ProjectStandup {
  project: string;
  completed: StandupTaskRef[];
  abandoned: StandupTaskRef[];
  started: StandupTaskRef[];
  planned_added: StandupTaskRef[];
  /** Currently blocked open tasks (not window-scoped — a blocker is a NOW fact). */
  blocked: StandupTaskRef[];
  /** Bugs currently awaiting regression verification (NOW fact). */
  awaiting_verification: StandupTaskRef[];
  /** Currently stale active tasks (advisory, derived). */
  stale: StandupTaskRef[];
  overlap_notices: number;
  boundary_agreements: number;
}

export interface StandupReport {
  window_hours: number;
  since: number;
  until: number;
  projects: ProjectStandup[];
  /** Present only when an iteration filter was given. */
  iteration_stock: IterationStock | null;
}

export interface StandupInput {
  /** Open tasks + tasks closed within the window (boardTasks shape). */
  tasks: TaskRow[];
  depsByTask: Map<string, DepInfo[]>;
  /** (project, kind) -> count of comments created within the window. */
  commentCounts: Array<{ project: string; kind: string; n: number }>;
  staleTtlHours: number;
  now: number;
  windowHours: number;
  project?: string | undefined;
  iteration?: string | undefined;
}

function ref(t: TaskRow): StandupTaskRef {
  return {
    task_id: t.id,
    title: t.title,
    project: t.project,
    owner_agent_id: t.owner_agent_id,
    iteration: t.iteration,
    type: t.type,
    severity: t.severity,
  };
}

/**
 * Deps still holding a task up: planned, active, or fixed prerequisites.
 * 'fixed' counts as blocking — the fix exists but is UNVERIFIED, and building
 * on unverified work is the failure this flag exists to warn about (advisory,
 * like everything here). It unblocks at verify_pass, when dependents also get
 * their DEPENDENCY RESOLVED notice.
 */
export function blockingDeps(deps: DepInfo[]): DepInfo[] {
  return deps.filter((d) => d.status === 'planned' || d.status === 'active' || d.status === 'fixed');
}

export function computeStandup(input: StandupInput): StandupReport {
  const { depsByTask, staleTtlHours, now, windowHours } = input;
  const since = now - windowHours * 3_600_000;

  let tasks = input.tasks;
  if (input.project) tasks = tasks.filter((t) => t.project === input.project);
  if (input.iteration) tasks = tasks.filter((t) => t.iteration === input.iteration);

  const byProject = new Map<string, ProjectStandup>();
  const projectOf = (name: string): ProjectStandup => {
    let p = byProject.get(name);
    if (!p) {
      p = {
        project: name,
        completed: [],
        abandoned: [],
        started: [],
        planned_added: [],
        blocked: [],
        awaiting_verification: [],
        stale: [],
        overlap_notices: 0,
        boundary_agreements: 0,
      };
      byProject.set(name, p);
    }
    return p;
  };

  for (const t of tasks) {
    const p = projectOf(t.project);
    if (t.closed_at !== null && t.closed_at > since) {
      (t.status === 'done' ? p.completed : p.abandoned).push(ref(t));
    }
    // A claim-then-close inside the window appears in BOTH started and completed.
    if (t.claimed_at !== null && t.claimed_at > since && t.status !== 'planned') {
      p.started.push(ref(t));
    }
    if (t.status === 'planned' && t.created_at > since) {
      p.planned_added.push(ref(t));
    }
    if (t.status === 'planned' || t.status === 'active') {
      const blockers = blockingDeps(depsByTask.get(t.id) ?? []);
      if (blockers.length > 0) {
        p.blocked.push({ ...ref(t), blocked_by: blockers.map((d) => d.task_id) });
      }
    }
    if (t.status === 'fixed') {
      p.awaiting_verification.push(ref(t));
    }
    if (t.status === 'active' && isStale(t.last_heartbeat_at, staleTtlHours, now)) {
      p.stale.push(ref(t));
    }
  }

  for (const c of input.commentCounts) {
    if (input.project && c.project !== input.project) continue;
    if (!byProject.has(c.project)) continue; // comment counts cannot be iteration-filtered; keep project-aligned
    const p = projectOf(c.project);
    if (c.kind === 'overlap_notice') p.overlap_notices += c.n;
    if (c.kind === 'boundary_agreement') p.boundary_agreements += c.n;
  }

  const iterationStock: IterationStock | null = input.iteration
    ? {
        iteration: input.iteration,
        planned: tasks.filter((t) => t.status === 'planned').map(ref),
        active: tasks.filter((t) => t.status === 'active').map(ref),
        fixed: tasks.filter((t) => t.status === 'fixed').map(ref),
      }
    : null;

  const projects = [...byProject.values()]
    .filter(
      (p) =>
        p.completed.length + p.abandoned.length + p.started.length + p.planned_added.length +
          p.blocked.length + p.awaiting_verification.length + p.stale.length +
          p.overlap_notices + p.boundary_agreements >
        0,
    )
    .sort((a, b) => a.project.localeCompare(b.project));

  return { window_hours: windowHours, since, until: now, projects, iteration_stock: iterationStock };
}
