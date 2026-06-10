import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BoardError } from '../../core/errors.js';
import { validateScopePath } from '../../core/globs.js';
import { computeOverlap } from '../../core/overlap.js';
import { didYouMean } from '../../core/slug.js';
import type { OverlapReport, ScopeRowInput, Severity } from '../../core/types.js';
import type { Db } from '../../db/connection.js';
import { insertComment, latestNoticeSeverity, noticeFirstLine, SYSTEM_AUTHOR } from '../../db/repo/comments.js';
import { activeTasksInProject, distinctActiveProjects } from '../../db/repo/tasks.js';
import { scopesByTasks } from '../../db/repo/scopes.js';
import type { BoardDeps } from '../deps.js';

export function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function fail(e: unknown): CallToolResult {
  const payload =
    e instanceof BoardError
      ? e.toPayload()
      : {
          error_code: 'VALIDATION_ERROR',
          message: e instanceof Error ? e.message : String(e),
          next_call_hint:
            'Re-read the tool description; every parameter documents where its value comes from.',
        };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** Convert thrown BoardErrors into result-level structured errors the model can read and recover from. */
export function runTool(fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (e) {
    return fail(e);
  }
}

export function validateScopeRows(scope: ScopeRowInput[]): void {
  for (const row of scope) {
    if (!row.path_glob && !row.module) {
      throw new BoardError('EMPTY_SCOPE_ROW', 'A scope row has neither path_glob nor module.');
    }
    if (row.path_glob) validateScopePath(row.path_glob);
  }
}

/** Assemble the overlap report for `scope` against all other active tasks in `project`. */
export function buildOverlapReport(
  deps: BoardDeps,
  project: string,
  scope: ScopeRowInput[],
  excludeTaskId: string | undefined,
  now: number,
): OverlapReport {
  const pool = activeTasksInProject(deps.db, project, excludeTaskId);
  const scopeMap = scopesByTasks(
    deps.db,
    pool.map((t) => t.id),
  );
  const counterparts = pool.map((task) => ({ task, scopeRows: scopeMap.get(task.id) ?? [] }));
  const known = distinctActiveProjects(deps.db).filter((p) => p !== project);
  const near = didYouMean(project, known);
  return computeOverlap({
    project,
    myScope: scope,
    counterparts,
    didYouMean: near.length > 0 ? near : null,
    staleTtlHours: deps.staleTtlHours,
    now,
  });
}

const NOTICE_RANK: Record<Severity, number> = { HIGH: 2, MEDIUM: 1, UNKNOWN: 0 };

export interface NoticeSource {
  taskId: string;
  title: string;
  owner: string;
  branch: string | null;
}

function describeMatches(report: OverlapReport, taskId: string, invert: boolean): string {
  const row = report.counterparts.find((c) => c.task_id === taskId);
  if (!row || row.matches.length === 0) return 'no concrete pair (severity from scope absence)';
  return row.matches
    .map((m) => {
      const a = invert ? m.theirs : m.mine;
      const b = invert ? m.mine : m.theirs;
      return m.channel === 'path'
        ? `path '${a.path_glob}' ~ '${b.path_glob}'`
        : `module '${a.module}' ~ '${b.module}'`;
    })
    .join('; ');
}

/**
 * Post symmetric 'overlap_notice' system comments on BOTH tasks for every
 * HIGH/MEDIUM counterpart — deduped per task pair: re-notify only when the
 * severity is new or has increased, so scope iteration during negotiation
 * (the canonical flow) does not spam either thread.
 * Must run inside the caller's transaction.
 */
export function postSymmetricNotices(
  db: Db,
  me: NoticeSource,
  report: OverlapReport,
  now: number,
): number {
  let posted = 0;
  for (const c of report.counterparts) {
    if (c.severity !== 'HIGH' && c.severity !== 'MEDIUM') continue;
    const prev = latestNoticeSeverity(db, me.taskId, c.task_id);
    if (prev !== null && NOTICE_RANK[prev] >= NOTICE_RANK[c.severity]) continue;

    const tail =
      "Coordinate via add_comment; record the agreed split as kind='boundary_agreement'.";
    insertComment(
      db,
      me.taskId,
      SYSTEM_AUTHOR,
      'overlap_notice',
      `${noticeFirstLine(c.severity, c.task_id)}\n[${c.severity}] scope overlap with '${c.title}' (${c.task_id}), owner ${c.owner_agent_id}, branch ${c.branch ?? 'n/a'}. Matched: ${describeMatches(report, c.task_id, false)}. ${tail}`,
      now,
    );
    insertComment(
      db,
      c.task_id,
      SYSTEM_AUTHOR,
      'overlap_notice',
      `${noticeFirstLine(c.severity, me.taskId)}\n[${c.severity}] scope overlap with '${me.title}' (${me.taskId}), owner ${me.owner}, branch ${me.branch ?? 'n/a'}. Matched: ${describeMatches(report, c.task_id, true)}. ${tail}`,
      now,
    );
    posted += 1;
  }
  return posted;
}
