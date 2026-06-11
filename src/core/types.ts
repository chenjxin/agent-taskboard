/** Severity of a scope overlap with a counterpart task. */
export type Severity = 'HIGH' | 'MEDIUM' | 'UNKNOWN';

/** 'fixed' = bug awaiting regression verification (bug-type tasks only). */
export type TaskStatus = 'planned' | 'active' | 'fixed' | 'done' | 'abandoned';

export type TaskType = 'dev' | 'bug';

export type BugSeverity = 'critical' | 'high' | 'medium' | 'low';

export type CommentKind = 'comment' | 'boundary_agreement' | 'overlap_notice' | 'dependency_notice';

/** A scope row as declared by an agent. At least one of path_glob / module must be present. */
export interface ScopeRowInput {
  path_glob?: string | null;
  module?: string | null;
  note?: string | null;
}

/** A scope row as stored. */
export interface ScopeRow {
  id: number;
  task_id: string;
  path_glob: string | null;
  module: string | null;
  note: string | null;
}

export interface TaskRow {
  id: string;
  project: string;
  title: string;
  description: string;
  branch: string | null;
  /** NULL = unclaimed backlog item (only legal while status is 'planned'). */
  owner_agent_id: string | null;
  created_by_agent_id: string;
  status: TaskStatus;
  type: TaskType;
  /** Bug triage level; meaningful for type='bug'. */
  severity: BugSeverity | null;
  /** Free-form sprint label agreed by the team, e.g. '2026w24'. */
  iteration: string | null;
  closing_note: string | null;
  created_at: number;
  updated_at: number;
  /** When the task became active (v1 rows: backfilled to created_at). */
  claimed_at: number | null;
  /** When the fix entered regression verification. NEVER doubles as closed_at. */
  fixed_at: number | null;
  closed_at: number | null;
  last_heartbeat_at: number;
}

export interface TaskDepRow {
  id: number;
  task_id: string;
  depends_on_task_id: string;
  created_at: number;
}

/** Dependency as exposed to callers: id + enough context to judge it. */
export interface DepInfo {
  task_id: string;
  title: string;
  status: TaskStatus;
}

export interface CommentRow {
  id: number;
  task_id: string;
  author_agent_id: string;
  kind: CommentKind;
  body: string;
  created_at: number;
}

/** One matched (mine, theirs) scope pair contributing to an overlap. */
export interface OverlapMatch {
  mine: { path_glob?: string; module?: string };
  theirs: { path_glob?: string; module?: string };
  channel: 'path' | 'module';
}

/** One counterpart task that overlaps (or cannot be ruled out). */
export interface OverlapCounterpart {
  task_id: string;
  title: string;
  /** What the counterpart is working on, truncated to 500 chars. */
  description: string;
  /** null = unclaimed backlog item. */
  owner_agent_id: string | null;
  /** 'planned' counterparts have not started — negotiating now is cheapest. */
  status: TaskStatus;
  branch: string | null;
  updated_at: number;
  last_heartbeat_at: number;
  hours_since_heartbeat: number;
  stale: boolean;
  severity: Severity;
  matches: OverlapMatch[];
  counterpart_broad_globs: string[];
  /** Stranger-proof instruction: what the calling agent should do about this counterpart. */
  next_step: string;
}

export interface OverlapReport {
  project: string;
  checked_scope_rows: number;
  /** Broad globs in MY declared scope (match from repo root). */
  broad_globs: string[];
  did_you_mean: string[] | null;
  counterparts: OverlapCounterpart[];
  /** Same-project active tasks with declared scopes that share nothing with mine. */
  low_contact_count: number;
  advice: string;
}

/** Input shape for the overlap engine: a counterpart task plus its declared scope rows. */
export interface CounterpartInput {
  task: TaskRow;
  scopeRows: ScopeRowInput[];
}
