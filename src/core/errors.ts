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
  EMPTY_SCOPE_ROW: 'EMPTY_SCOPE_ROW',
  INVALID_SCOPE_PATH: 'INVALID_SCOPE_PATH',
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
  EMPTY_SCOPE_ROW: 'Each scope row needs path_glob and/or module.',
  INVALID_SCOPE_PATH:
    "Provide repo-relative posix paths or globs like 'src/auth/**' — no absolute paths, no drive letters, no '..' segments.",
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
