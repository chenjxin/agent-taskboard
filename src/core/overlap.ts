/**
 * Overlap engine: pure severity computation and report assembly.
 *
 * Severity per counterpart = max across all (my row, their row) pairs:
 *   HIGH    = any path-channel intersection (negotiate before writing code)
 *   MEDIUM  = no path hit, but a module-channel match
 *   UNKNOWN = either side declared zero scope (cannot rule out a conflict)
 *   no contact (both sides scoped, zero hits) -> excluded, counted only.
 *
 * Stale counterparts stay IN the report, flagged — stale != dead.
 */
import { isBroadGlob, pathPairIntersects } from './globs.js';
import { hoursSince, isStale } from './staleness.js';
import type {
  CounterpartInput,
  OverlapCounterpart,
  OverlapMatch,
  OverlapReport,
  ScopeRowInput,
  Severity,
} from './types.js';

export const OVERLAP_ADVICE =
  'Informational only — the board never blocks or assigns; proceeding despite an overlap is a human call. ' +
  'On HIGH/MEDIUM, coordinate with the owner via add_comment and record the agreed split as a boundary_agreement.';

const DESCRIPTION_LIMIT = 500;
const SEVERITY_RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, UNKNOWN: 2 };

function normModule(m: string): string {
  return m.trim().toLowerCase();
}

/**
 * Case-insensitive full-string equality or '/'-prefix relation.
 * Deliberately NO token splitting: 'user-api' vs 'payment-api' must NOT match,
 * or generic tokens (api, core, utils) turn the module channel into alert noise.
 */
export function moduleMatches(a: string, b: string): boolean {
  const na = normModule(a);
  const nb = normModule(b);
  if (!na || !nb) return false;
  return na === nb || nb.startsWith(na + '/') || na.startsWith(nb + '/');
}

export interface ComputeOverlapArgs {
  project: string;
  myScope: ScopeRowInput[];
  counterparts: CounterpartInput[];
  didYouMean: string[] | null;
  staleTtlHours: number;
  now: number;
  /** The agent asking — its OWN other tasks get sequencing advice, not "negotiate with yourself". */
  caller?: string | undefined;
}

interface PairEvaluation {
  severity: Severity;
  matches: OverlapMatch[];
}

/** null = both sides scoped, zero contact. */
function evaluatePairs(mine: ScopeRowInput[], theirs: ScopeRowInput[]): PairEvaluation | null {
  if (mine.length === 0 || theirs.length === 0) return { severity: 'UNKNOWN', matches: [] };

  const matches: OverlapMatch[] = [];
  let pathHit = false;
  let moduleHit = false;
  for (const m of mine) {
    for (const t of theirs) {
      if (m.path_glob && t.path_glob && pathPairIntersects(m.path_glob, t.path_glob)) {
        pathHit = true;
        matches.push({ mine: { path_glob: m.path_glob }, theirs: { path_glob: t.path_glob }, channel: 'path' });
      }
      if (m.module && t.module && moduleMatches(m.module, t.module)) {
        moduleHit = true;
        matches.push({ mine: { module: m.module }, theirs: { module: t.module }, channel: 'module' });
      }
    }
  }
  if (pathHit) return { severity: 'HIGH', matches };
  if (moduleHit) return { severity: 'MEDIUM', matches };
  return null;
}

/**
 * Bare contact test between two scope sets, for routing (which backlog bugs sit
 * on whose turf). Unlike the full report, UNKNOWN (either side scopeless) maps
 * to null: routing needs a POSITIVE signal — a scopeless bug routed to everyone
 * is noise, not information.
 */
export function scopesTouch(mine: ScopeRowInput[], theirs: ScopeRowInput[]): 'HIGH' | 'MEDIUM' | null {
  const evaluated = evaluatePairs(mine, theirs);
  if (evaluated === null || evaluated.severity === 'UNKNOWN') return null;
  return evaluated.severity;
}

function broadGlobsOf(scope: ScopeRowInput[]): string[] {
  return scope.filter((r) => r.path_glob && isBroadGlob(r.path_glob)).map((r) => r.path_glob as string);
}

function nextStepFor(
  c: CounterpartInput,
  severity: Severity,
  stale: boolean,
  hoursAgo: number,
  caller: string | undefined,
): string {
  const owner = c.task.owner_agent_id ?? 'unclaimed';
  const human = c.task.owner_agent_id?.split('/')[0];
  if (caller !== undefined && c.task.owner_agent_id === caller) {
    return (
      `'${c.task.title}' (${c.task.id}) is YOUR OWN task — no negotiation needed, just sequence the work ` +
      `(and make sure this registration is not an accidental duplicate of it).`
    );
  }
  let step: string;
  switch (severity) {
    case 'HIGH':
      step =
        `Path-level overlap with '${c.task.title}'. BEFORE writing code in the shared paths, call get_task('${c.task.id}'), ` +
        `read its thread, and use add_comment to agree on a file boundary and interface contract with ${owner}.`;
      break;
    case 'MEDIUM':
      step =
        `Module-level overlap with '${c.task.title}'. Check get_task('${c.task.id}') to see whether your file-level plans ` +
        `actually collide; if they might, coordinate with ${owner} via add_comment.`;
      break;
    case 'UNKNOWN':
      step =
        `'${c.task.title}' declared no scope, so a conflict cannot be ruled out. Use add_comment on task '${c.task.id}' ` +
        `to ask ${owner} for a scope declaration (update_scope), and describe what you plan to touch.`;
      break;
  }
  if (c.task.status === 'planned') {
    step += c.task.owner_agent_id
      ? ` NOTE: that task is still PLANNED (not started) — negotiating the boundary NOW, before either side writes code, is the cheapest moment.`
      : ` NOTE: that task is an UNCLAIMED backlog item. If it is yours to do, claim_task it; otherwise leave your boundary as a comment — whoever claims it gets the full thread.`;
  }
  if (stale) {
    step +=
      ` NOTE: owner's last heartbeat was ${hoursAgo}h ago (stale — advisory, the session may just be paused). ` +
      `Comment for the record${human ? `, consider contacting ${human} directly` : ''}, and proceed with caution.`;
  }
  return step;
}

export function computeOverlap(args: ComputeOverlapArgs): OverlapReport {
  const { project, myScope, counterparts, didYouMean, staleTtlHours, now, caller } = args;

  const rows: OverlapCounterpart[] = [];
  let lowContactCount = 0;

  for (const c of counterparts) {
    const evaluated = evaluatePairs(myScope, c.scopeRows);
    if (evaluated === null) {
      lowContactCount += 1;
      continue;
    }
    const stale = c.task.status === 'active' && isStale(c.task.last_heartbeat_at, staleTtlHours, now);
    const hoursAgo = hoursSince(c.task.last_heartbeat_at, now);
    rows.push({
      task_id: c.task.id,
      title: c.task.title,
      description: c.task.description.slice(0, DESCRIPTION_LIMIT),
      owner_agent_id: c.task.owner_agent_id,
      status: c.task.status,
      branch: c.task.branch,
      updated_at: c.task.updated_at,
      last_heartbeat_at: c.task.last_heartbeat_at,
      hours_since_heartbeat: hoursAgo,
      stale,
      severity: evaluated.severity,
      matches: evaluated.matches,
      counterpart_broad_globs: broadGlobsOf(c.scopeRows),
      next_step: nextStepFor(c, evaluated.severity, stale, hoursAgo, caller),
    });
  }

  rows.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.task_id.localeCompare(b.task_id),
  );

  return {
    project,
    checked_scope_rows: myScope.length,
    broad_globs: broadGlobsOf(myScope),
    did_you_mean: didYouMean,
    counterparts: rows,
    low_contact_count: lowContactCount,
    advice: OVERLAP_ADVICE,
  };
}
