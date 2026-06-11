/**
 * Structured, model-recoverable errors. Tool handlers convert these into
 * result-level errors: { isError: true, content: [{ type: 'text', text: JSON of
 * { error_code, message, next_call_hint } }] } so the calling agent can read
 * the hint and recover instead of seeing an opaque protocol failure.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  NOT_TASK_OWNER: 'NOT_TASK_OWNER',
  TASK_ALREADY_CLOSED: 'TASK_ALREADY_CLOSED',
  TASK_NOT_ACTIVE: 'TASK_NOT_ACTIVE',
  TASK_ALREADY_CLAIMED: 'TASK_ALREADY_CLAIMED',
  DEP_CYCLE: 'DEP_CYCLE',
  NOT_A_BUG: 'NOT_A_BUG',
  BUG_NOT_ACTIVE: 'BUG_NOT_ACTIVE',
  BUG_NOT_FIXED: 'BUG_NOT_FIXED',
  EMPTY_SCOPE_ROW: 'EMPTY_SCOPE_ROW',
  INVALID_SCOPE_PATH: 'INVALID_SCOPE_PATH',
  RESOURCE_HELD: 'RESOURCE_HELD',
  NOT_RESOURCE_HOLDER: 'NOT_RESOURCE_HOLDER',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  NOT_A_DEPENDENT: 'NOT_A_DEPENDENT',
  NUDGE_COOLDOWN: 'NUDGE_COOLDOWN',
  TASK_NOT_WAITABLE: 'TASK_NOT_WAITABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const DEFAULT_HINTS: Record<ErrorCode, string> = {
  VALIDATION_ERROR:
    'Re-read the tool description; every parameter documents where its value comes from.',
  TASK_NOT_FOUND:
    'Call list_tasks with a project filter to discover valid task ids; your saved .claude/board-task.json may be stale.',
  NOT_TASK_OWNER:
    'Only the owner may modify a task. Use add_comment to coordinate with the owner instead, or operate on your own task.',
  TASK_ALREADY_CLOSED:
    'This task is done/abandoned (see closing_note via get_task). Register a new task if the work resumes.',
  TASK_NOT_ACTIVE:
    "This task is still 'planned' (not started). Call claim_task to take it and start working — that also returns the full thread and a fresh overlap report.",
  TASK_ALREADY_CLAIMED:
    'Someone claimed this task first (or it is no longer planned). Call get_task to see its current owner, then coordinate via add_comment.',
  DEP_CYCLE:
    'This dependency would create a cycle (A waiting on B waiting on A). Re-think the split, or drop one direction and record the relationship via add_comment instead.',
  NOT_A_BUG:
    "update_bug_state only works on type='bug' tasks. For dev tasks use update_status (done|abandoned).",
  BUG_NOT_ACTIVE:
    "fix_ready requires an ACTIVE bug you own. planned -> claim_task first; fixed -> it already awaits verification; closed -> register a new bug.",
  BUG_NOT_FIXED:
    "verify_pass/verify_fail require a bug in 'fixed' (awaiting verification). An active bug is not fix-ready yet — the owner calls fix_ready first.",
  EMPTY_SCOPE_ROW: 'Each scope row needs path_glob and/or module.',
  INVALID_SCOPE_PATH:
    "Provide repo-relative posix paths or globs like 'src/auth/**' — no absolute paths, no drive letters, no '..' segments.",
  RESOURCE_HELD:
    'The resource is currently claimed by someone else (holder/until/note are in this error). Negotiate via add_comment on their task or wait for expiry — the board records claims, it never evicts holders.',
  NOT_RESOURCE_HOLDER:
    'Only the current holder can release a claim. If the holder is unresponsive past reason, talk human-to-human; claims auto-expire at their until time.',
  RESOURCE_NOT_FOUND:
    'No live claim with that (project, name). get_standup lists current claims; the claim may simply have expired already.',
  NOT_A_DEPENDENT:
    'Nudging requires a real depends_on edge from YOUR task to the blocker. Add the dependency via update_task first if it genuinely blocks you.',
  NUDGE_COOLDOWN:
    'This blocker was already nudged for this dependent within 24h. Nudges never escalate automatically — if it is urgent, talk to your human.',
  TASK_NOT_WAITABLE:
    "Only YOUR OWN 'active' task can enter 'waiting' (and only 'waiting' can resume to 'active').",
};

export class BoardError extends Error {
  readonly error_code: ErrorCode;
  readonly next_call_hint: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'BoardError';
    this.error_code = code;
    this.next_call_hint = hint ?? DEFAULT_HINTS[code];
  }

  toPayload(): { error_code: ErrorCode; message: string; next_call_hint: string } {
    return { error_code: this.error_code, message: this.message, next_call_hint: this.next_call_hint };
  }
}
