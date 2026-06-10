/**
 * Stranger-proof text for the MCP surface, kept out of the logic files.
 * Rule: the calling agent knows NOTHING — every description says when to use
 * the tool AND when not to; every error hints at the next call.
 */

export const SERVER_INSTRUCTIONS = `Team task coordination board for AI coding agents. It INFORMS, it never assigns: there is no task queue and no 'next task' here — humans hand out work; the board only makes parallel work visible so agents stop colliding.

Identity: every call takes agent_id in the form '<human>/<agent>' (e.g. 'wang/claude-main'). Use the identical value in every call and every session — your team records it in the repo's CLAUDE.md.

Canonical flow WHEN A HUMAN HANDS YOU A DEV TASK (do this before writing code):
1. Derive the project slug: basename of \`git remote get-url origin\`, strip '.git', lowercase (no remote -> repo directory name). Derive branch: \`git branch --show-current\`.
2. check_overlap with the path globs / module names you intend to touch.
3. register_task — registering IS claiming. Persist the returned task.id to .claude/board-task.json in your worktree.
4. If the overlap report lists HIGH/MEDIUM counterparts: read them (get_task), tell your human, and negotiate a file boundary + interface contract via add_comment on the counterpart's thread; record the agreed split as kind='boundary_agreement'.
5. While working / when resuming a worktree: heartbeat — it refreshes your liveness AND returns what happened on your task since your last beat (including system overlap notices).
6. When the work is merged or dropped: update_status ('done'|'abandoned') with a closing_note, then delete .claude/board-task.json.

Overlap results are information with a severity (HIGH/MEDIUM/UNKNOWN), never a verdict — proceeding despite an overlap is a human decision. 'stale' flags are advisory (derived from heartbeat age, default TTL 8h); a stale task may still be live, and the board never auto-closes anything.`;

export const TOOL_DESCRIPTIONS = {
  register_task: `Register the task you are STARTING on the board — registering is how you claim it. USE when a human hands you a dev task and you know roughly which files/areas you will touch (run check_overlap first, or rely on this response: it embeds the same full overlap report). DO NOT use to create work for other people (the board never assigns), to update an existing task (use update_scope / add_comment / update_status), or as a personal todo list. After success: persist response.task.id into .claude/board-task.json in your worktree, and act on response.overlap_report — HIGH/MEDIUM counterparts mean coordinate via add_comment BEFORE writing code in the shared paths.`,

  list_tasks: `Browse board tasks. USE at session start (pass owner_agent_id = your own agent_id to recover your open tasks after a context reset) and to survey who is currently active in a project. Results are capped at 200 rows — filter by project. Every row carries a derived 'stale' flag (advisory only). DO NOT use to find work to pick up — there is no queue here. For one task's full thread use get_task; for scope-collision analysis use check_overlap (it matches globs; this tool only filters fields).`,

  get_task: `Full detail of one task: all fields, scope declarations, and the complete comment thread (including system overlap notices and boundary agreements), plus staleness info. USE before commenting on or coordinating with a task, and to catch up on a negotiation thread. Read-only.`,

  check_overlap: `Dry-run collision check: would this scope touch what other ACTIVE tasks in the same project are touching? USE when you receive a dev task, BEFORE register_task — and again later to probe a refactor's blast radius. Writes nothing, notifies nobody, safe to repeat. The result is information with a severity per counterpart (HIGH = declared paths intersect; MEDIUM = same declared module; UNKNOWN = counterpart declared no scope so a conflict cannot be ruled out), never a verdict: proceeding despite HIGH is your human's call. If you already registered, pass exclude_task_id = your own task id so you do not collide with yourself.`,

  update_scope: `Replace YOUR task's declared scope when the plan changes (you discovered new files/areas to touch, or you agreed a narrower boundary with a counterpart). Owner-only. The scope array is a FULL REPLACEMENT — include rows you want to keep. Returns a fresh overlap report; new or increased HIGH/MEDIUM overlaps auto-post a system notice on both tasks. DO NOT use on someone else's task (use add_comment to ask them) or on a closed task.`,

  add_comment: `Post to a task's comment thread. USE to coordinate after an overlap notice (propose a file boundary, an interface contract, API shapes, event names), to leave context for whoever works nearby next, and — once both sides converge — to record the final split as kind='boundary_agreement' (one comment restating the agreed boundary so later readers do not need the whole thread). Coordination happens on the COUNTERPART's thread: comment on their task_id so their next heartbeat surfaces it. Any agent may comment on any task. DO NOT use to change status (update_status) or scope (update_scope); kind='overlap_notice' is reserved for the system.`,

  update_status: `Close YOUR task as 'done' (work merged/landed) or 'abandoned' (dropped). Owner-only, and the ONLY way a task ever closes — the board never auto-closes, stale flags are advisory. closing_note is REQUIRED: say what merged/landed where, or why you abandoned and what remains — the next agent working in this area will read it. There is no transition back to 'active': if work resumes, register a new task. After success: delete .claude/board-task.json from your worktree.`,

  heartbeat: `Refresh liveness on YOUR task AND pull what happened since your previous heartbeat. USE when resuming work in a worktree whose .claude/board-task.json exists (e.g. at session start) and periodically during long sessions — it is how you learn that someone overlapped with you or replied to a negotiation. Owner-only. Returns activity: comments others (including 'system' overlap notices) posted on your task since your previous beat — READ them before continuing.`,
} as const;

export const PARAM_DESCRIPTIONS = {
  agent_id:
    "Your stable identity as '<human>/<agent>', e.g. 'wang/claude-main'. Origin: the 'agent_id:' line your team keeps in CLAUDE.md (or the AGENT_BOARD_ID env var). Use the IDENTICAL value in every call and every session; never invent a new one per session. 'system' is reserved.",
  project:
    "Repo slug. Origin: basename of `git remote get-url origin`, strip '.git', lowercase (e.g. 'git@host:team/Web-App.git' -> 'web-app'); if the repo has no remote, use the repo directory name. The server re-normalizes and the response tells you if it changed your value.",
  task_id:
    "Origin: the task.id returned by register_task (you saved it in .claude/board-task.json), or a row from list_tasks / an overlap report.",
  title:
    "One line a teammate understands without opening anything else; <= 200 chars. Narrow titles keep overlap reports meaningful — 'migrate auth session storage to redis', not 'fix stuff'.",
  description:
    'Goal + intended approach in a few sentences. Other agents read this to understand what you are doing when their scope overlaps yours.',
  branch: "Git branch you work on. Origin: `git branch --show-current`. Optional.",
  scope:
    "Files/areas this task will touch, as rows of {path_glob, module, note}. Strongly recommended: tasks without scope appear as UNKNOWN (unverifiable) to every teammate's overlap check. Derive from your implementation plan.",
  path_glob:
    "Repo-relative posix path or glob you expect to touch, e.g. 'src/auth/**' or 'src/auth/login.ts'. A bare directory counts as its whole subtree. No absolute paths, no drive letters, no '..'.",
  module:
    "Logical area name, e.g. 'auth' or 'auth/session'. Matched against other tasks by exact name or '/'-prefix relation only — agree on consistent names with your team.",
  scope_note: 'Optional free text about this row, e.g. what you will do there.',
  status_filter: "Filter by lifecycle state; default 'active'. 'all' includes done/abandoned history.",
  owner_filter:
    'Filter to one agent. Pass your OWN agent_id at session start to recover your open tasks after a context reset.',
  exclude_task_id:
    'Pass your own task id (from .claude/board-task.json) when re-checking after registration, so you do not collide with yourself. Omit on the first check.',
  comment_body:
    'The message. For boundary proposals be concrete: file lists, function signatures, API shapes, event names — the other agent should be able to code against it.',
  comment_kind:
    "'comment' (default) for discussion; 'boundary_agreement' ONLY once both sides converged, restating the final boundary. 'overlap_notice' is reserved for the system.",
  close_status: "'done' = merged/landed; 'abandoned' = dropped. Nothing else closes a task.",
  closing_note:
    'REQUIRED. What merged/landed where, or why abandoned and what remains. The next agent in this area reads this.',
} as const;
