/**
 * Business cores shared by MCP tool handlers AND the human HTTP endpoints
 * (/api/bugs, /api/bugs/:id/verify). One implementation, two doors — a
 * web-reported bug must behave byte-identically to an MCP-registered one.
 */
import { BoardError } from '../core/errors.js';
import { normalizeProjectSlug } from '../core/slug.js';
import type { BugSeverity, OverlapReport, ScopeRowInput, TaskRow, TaskType } from '../core/types.js';
import { didYouMean } from '../core/slug.js';
import { newTaskId } from '../db/ids.js';
import { allAgentIds, isKnownAgent, upsertAgent } from '../db/repo/agents.js';
import { depNoticeFirstLine, insertComment, SYSTEM_AUTHOR } from '../db/repo/comments.js';
import { dependentsOf, depInfos, replaceDeps } from '../db/repo/deps.js';
import { insertScopeRows } from '../db/repo/scopes.js';
import { getTask, insertTask, markBugFixed, reopenBug, setStatus } from '../db/repo/tasks.js';
import type { BoardDeps } from './deps.js';
import {
  buildOverlapReport,
  postSymmetricNotices,
  validateDeps,
  validateScopeRows,
} from './tools/shared.js';

export interface RegisterTaskArgs {
  agent_id: string;
  project: string;
  title: string;
  description?: string | undefined;
  branch?: string | undefined;
  scope?: ScopeRowInput[] | undefined;
  start_as?: 'active' | 'planned' | 'backlog' | undefined;
  iteration?: string | undefined;
  depends_on?: string[] | undefined;
  type?: TaskType | undefined;
  severity?: BugSeverity | undefined;
}

/**
 * Identities are minted silently on first use (self-reported trust model), so
 * a one-character typo creates a parallel identity nobody notices. At the two
 * identity-establishing writes (register/claim) we warn — never block — when a
 * BRAND-NEW agent_id closely resembles an existing one. Call BEFORE upsert.
 */
export function newIdentityHint(deps: BoardDeps, agentId: string): string | null {
  if (isKnownAgent(deps.db, agentId)) return null;
  const near = didYouMean(agentId, allAgentIds(deps.db));
  if (near.length === 0) return null;
  return (
    `First time seeing identity '${agentId}' — it was created. It closely resembles existing identit${near.length > 1 ? 'ies' : 'y'}: ${near.join(', ')}. ` +
    `If this is a spelling drift, switch to the existing value and keep it stable across sessions (CLAUDE.md 'agent_id:' line is the source of truth).`
  );
}

export function registerTaskCore(deps: BoardDeps, args: RegisterTaskArgs): Record<string, unknown> {
  const now = deps.now();
  const startAs = args.start_as ?? 'active';
  const type: TaskType = args.type ?? 'dev';
  const scope: ScopeRowInput[] = args.scope ?? [];
  validateScopeRows(scope);
  const { slug, changed } = normalizeProjectSlug(args.project);
  if (!slug) {
    throw new BoardError('VALIDATION_ERROR', `project '${args.project}' resolved to an empty slug`);
  }

  const id = newTaskId();
  const status = startAs === 'active' ? 'active' : 'planned';
  const owner = startAs === 'backlog' ? null : args.agent_id;
  const identityHint = newIdentityHint(deps, args.agent_id);
  let report!: OverlapReport;
  deps.db.transaction(() => {
    upsertAgent(deps.db, args.agent_id, now);
    if (args.depends_on) validateDeps(deps.db, id, args.depends_on);
    const task: TaskRow = {
      id,
      project: slug,
      title: args.title,
      description: args.description ?? '',
      branch: args.branch ?? null,
      owner_agent_id: owner,
      created_by_agent_id: args.agent_id,
      status,
      type,
      severity: args.severity ?? null,
      iteration: args.iteration?.trim() || null,
      closing_note: null,
      created_at: now,
      updated_at: now,
      claimed_at: status === 'active' ? now : null,
      fixed_at: null,
      closed_at: null,
      last_heartbeat_at: now,
    };
    insertTask(deps.db, task);
    insertScopeRows(deps.db, id, scope);
    if (args.depends_on) replaceDeps(deps.db, id, args.depends_on, now);
    report = buildOverlapReport(deps, slug, scope, id, now, args.agent_id);
    // planned/backlog registrations notify NOBODY — notices fire at claim_task time.
    if (status === 'active') {
      postSymmetricNotices(
        deps.db,
        { taskId: id, title: args.title, owner: args.agent_id, branch: args.branch ?? null },
        report,
        now,
      );
    }
  })();

  const ownOverlapping = report.counterparts.filter((c) => c.owner_agent_id === args.agent_id);
  const finalDeps = args.depends_on ? depInfos(deps.db, id) : [];
  const closedDepWarning = finalDeps.filter((d) => d.status === 'done' || d.status === 'abandoned');
  return {
    task: getTask(deps.db, id) as TaskRow,
    normalized_project: { slug, changed },
    depends_on: finalDeps,
    warnings: {
      duplicate_task_hint:
        ownOverlapping.length > 0
          ? `You already own ${ownOverlapping.length} other open overlapping task(s) in '${slug}': ${ownOverlapping
              .map((c) => c.task_id)
              .join(', ')}. Parallel worktrees are legitimate — make sure this is intentional, not a duplicate registration.`
          : null,
      broad_globs: report.broad_globs,
      did_you_mean: report.did_you_mean,
      no_scope_warning:
        scope.length === 0
          ? "No scope declared: this task appears as UNKNOWN to every teammate's overlap check. Call update_scope once you know which files you will touch."
          : null,
      already_closed_deps:
        closedDepWarning.length > 0
          ? `Dependency task(s) already closed: ${closedDepWarning.map((d) => `${d.task_id} (${d.status})`).join(', ')}.`
          : null,
      severity_on_dev:
        args.severity && type !== 'bug'
          ? "severity is a bug-triage field; it was stored but only type='bug' tasks surface it in bug views."
          : null,
      new_identity_hint: identityHint,
    },
    overlap_report: report,
    next_step:
      status === 'active'
        ? `Persist {"task_id":"${id}","project":"${slug}"} to .claude/board-task.json in your worktree (gitignored). Then act on overlap_report: HIGH/MEDIUM counterparts mean coordinate via add_comment BEFORE writing code in the shared paths.`
        : startAs === 'backlog'
          ? `${type === 'bug' ? 'Bug' : 'Backlog item'} '${id}' filed (unowned). Nobody was notified — whoever claims it via claim_task receives the full thread, so leave context as comments.${
              type === 'bug' ? ' The fixer will go fix_ready -> verify_pass/verify_fail after claiming.' : ''
            } Note overlap_report: if it shows HIGH counterparts, mention them in a comment now.`
          : `Planned task '${id}' recorded (yours, not started). Nobody was notified. When you start the work, call claim_task('${id}') — that fires overlap notices and returns a fresh report.`,
  };
}

/**
 * Close a task (done|abandoned) and notify open dependents. MUST be called
 * inside the caller's transaction. Returns the notified dependent ids.
 */
export function closeTaskInTx(
  deps: BoardDeps,
  task: TaskRow,
  status: 'done' | 'abandoned',
  closingNote: string,
  now: number,
): string[] {
  if (!setStatus(deps.db, task.id, status, closingNote, now)) {
    throw new BoardError('TASK_ALREADY_CLOSED', `Task '${task.id}' was closed concurrently.`);
  }
  const dependents = dependentsOf(deps.db, task.id).filter(
    (d) => d.status === 'planned' || d.status === 'active' || d.status === 'fixed',
  );
  for (const dep of dependents) {
    insertComment(
      deps.db,
      dep.task_id,
      SYSTEM_AUTHOR,
      'dependency_notice',
      `${depNoticeFirstLine(status, task.id)}\nYour dependency '${task.title}' (${task.id}) was closed as ${status.toUpperCase()}${
        status === 'abandoned' ? ' — the prerequisite work was NOT completed' : ''
      }. Closing note: ${closingNote}`,
      now,
    );
  }
  return dependents.map((d) => d.task_id);
}

export type BugEvent = 'fix_ready' | 'verify_pass' | 'verify_fail';

export interface UpdateBugStateArgs {
  actor: string;
  task_id: string;
  event: BugEvent;
  note: string;
  /** Which door was used — the only honest provenance signal in the system. */
  via: 'mcp' | 'web';
}

export function updateBugStateCore(deps: BoardDeps, args: UpdateBugStateArgs): Record<string, unknown> {
  const now = deps.now();
  const note = args.note.trim();
  if (note.length === 0) {
    throw new BoardError(
      'VALIDATION_ERROR',
      'note is required.',
      'fix_ready: describe the fix + how to verify it. verify_fail: what failed. verify_pass: what you checked.',
    );
  }
  const task = getTask(deps.db, args.task_id);
  if (!task) throw new BoardError('TASK_NOT_FOUND', `No task with id '${args.task_id}'.`);
  if (task.type !== 'bug') {
    throw new BoardError('NOT_A_BUG', `Task '${task.id}' is type='${task.type}'.`);
  }
  const closed = task.status === 'done' || task.status === 'abandoned';

  if (args.event === 'fix_ready') {
    if (closed) throw new BoardError('TASK_ALREADY_CLOSED', `Bug '${task.id}' is already ${task.status}.`);
    if (task.status === 'planned') {
      throw new BoardError('BUG_NOT_ACTIVE', `Bug '${task.id}' is still planned — nobody is fixing it yet.`);
    }
    if (task.status === 'fixed') {
      throw new BoardError('BUG_NOT_ACTIVE', `Bug '${task.id}' is already fixed, awaiting verification.`);
    }
    if (task.owner_agent_id !== args.actor) {
      throw new BoardError(
        'NOT_TASK_OWNER',
        `Bug '${task.id}' is being fixed by ${task.owner_agent_id}, not you (${args.actor}).`,
      );
    }
    deps.db.transaction(() => {
      upsertAgent(deps.db, args.actor, now);
      if (!markBugFixed(deps.db, task.id, now)) {
        throw new BoardError('VALIDATION_ERROR', `Bug '${task.id}' changed state concurrently — re-read it via get_task.`);
      }
      insertComment(
        deps.db,
        task.id,
        SYSTEM_AUTHOR,
        'comment',
        `FIX READY task:${task.id}\nFix by ${args.actor} (via ${args.via}). 修复说明与验证方法:\n${note}`,
        now,
      );
    })();
    return {
      task: getTask(deps.db, task.id),
      next_step:
        'KEEP .claude/board-task.json until verification passes. The bug now shows as 待回归 on the board; the reporter (or any teammate/human) verifies via update_bug_state or the board buttons. A verify_fail arrives through your heartbeat — keep beating while you wait or work on other things.',
    };
  }

  // verify_pass / verify_fail both require the awaiting-verification state.
  if (closed) throw new BoardError('TASK_ALREADY_CLOSED', `Bug '${task.id}' is already ${task.status}.`);
  if (task.status !== 'fixed') {
    throw new BoardError('BUG_NOT_FIXED', `Bug '${task.id}' is '${task.status}', not awaiting verification.`);
  }

  if (args.event === 'verify_pass') {
    const selfVerified = args.actor === task.owner_agent_id;
    const closingNote = `[verified by ${args.actor} via ${args.via}] ${note}`;
    let dependents: string[] = [];
    deps.db.transaction(() => {
      upsertAgent(deps.db, args.actor, now);
      dependents = closeTaskInTx(deps, task, 'done', closingNote, now);
    })();
    return {
      task: getTask(deps.db, task.id),
      dependents_notified: dependents,
      warnings: {
        self_verification: selfVerified
          ? 'Fixer and verifier are the same identity — recorded as such; a second pair of eyes is the point of regression.'
          : null,
      },
      next_step: 'Verification recorded. The fixer can delete .claude/board-task.json now.',
    };
  }

  // verify_fail
  deps.db.transaction(() => {
    upsertAgent(deps.db, args.actor, now);
    if (!reopenBug(deps.db, task.id, now)) {
      throw new BoardError('VALIDATION_ERROR', `Bug '${task.id}' changed state concurrently — re-read it via get_task.`);
    }
    insertComment(
      deps.db,
      task.id,
      SYSTEM_AUTHOR,
      'comment',
      `FIX REJECTED task:${task.id}\nRegression FAILED, verified by ${args.actor} (via ${args.via}). 原因:\n${note}`,
      now,
    );
  })();
  return {
    task: getTask(deps.db, task.id),
    next_step:
      'Bug is back to active with the same owner; the rejection reason was posted on its thread and will surface in the owner\'s next heartbeat.',
  };
}