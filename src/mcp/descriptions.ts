/**
 * Stranger-proof text for the MCP surface, kept out of the logic files.
 * Rule: the calling agent knows NOTHING — every description says when to use
 * the tool AND when not to; every error hints at the next call.
 */

export const SERVER_INSTRUCTIONS = `Team task coordination board for AI coding agents. It INFORMS, it never assigns: the board has a backlog, but nothing on it is ever pushed to anyone — claiming is always a voluntary act by an agent (usually because its human said so). Humans hand out work; the board makes parallel work visible so agents stop colliding.

Identity: every call takes agent_id in the form '<human>/<agent>' (e.g. 'wang/claude-main'). Use the identical value in every call and every session — your team records it in the repo's CLAUDE.md.

Canonical flow WHEN A HUMAN HANDS YOU A DEV TASK (do this before writing code):
1. Derive the project slug: basename of \`git remote get-url origin\`, strip '.git', lowercase (no remote -> repo directory name). Derive branch: \`git branch --show-current\`.
2. Optional but cheap: get_standup for the project — what shipped/started/blocked in the last 24h.
3. check_overlap with the path globs / module names you intend to touch.
4. If your task already sits on the board as a planned/backlog item: claim_task it (you get the full thread + a fresh overlap report). Otherwise register_task — the default registers you as actively working. Persist the returned task.id to .claude/board-task.json in your worktree.
5. If the overlap report lists HIGH/MEDIUM counterparts: read them (get_task), tell your human, and negotiate a file boundary + interface contract via add_comment on the counterpart's thread; record the agreed split as kind='boundary_agreement'. PLANNED counterparts have not started — negotiating with them now is cheapest.
6. While working / when resuming a worktree: heartbeat — it refreshes your liveness AND returns what happened on your task since your last beat (overlap notices, dependency notices, replies).
7. When the work is merged or dropped: update_status ('done'|'abandoned') with a closing_note, then delete .claude/board-task.json. Closing a task auto-notifies every task that declared a dependency on it.

Planning ahead: register_task with start_as='planned' announces work you will do later; start_as='backlog' files an unowned item anyone may claim. Tasks can carry an iteration label (sprint) and depends_on links — both purely informational.

Overlap results are information with a severity (HIGH/MEDIUM/UNKNOWN), never a verdict — proceeding despite an overlap is a human decision. 'stale' flags are advisory (derived from heartbeat age, default TTL 8h); a stale task may still be live, and the board never auto-closes anything.`;

export const TOOL_DESCRIPTIONS = {
  register_task: `Put a task on the board. Default (start_as='active') registers you as ACTIVELY working — registering is claiming. start_as='planned' announces work you will do later (yours, not started); start_as='backlog' files an UNOWNED item for whoever claims it (claim_task). USE when a human hands you a dev task (active), or when planning future work (planned/backlog). DO NOT use to update an existing task (update_task / update_scope / add_comment / update_status) or to assign work to a specific person — the board never assigns. planned/backlog registrations return the overlap report but notify nobody; notices fire when the task is claimed. After an ACTIVE registration: persist response.task.id into .claude/board-task.json in your worktree, and act on response.overlap_report — HIGH/MEDIUM counterparts mean coordinate via add_comment BEFORE writing code in the shared paths.`,

  claim_task: `Claim a planned/backlog task and start working on it: sets you as owner, flips it to active, and returns the FULL comment thread (negotiation that happened before you claimed — READ it), the scope rows, and a fresh overlap report (this is the moment overlap notices fire). USE when your human points you at an existing board item, or to activate your own planned task. DO NOT claim someone else's OWNED planned task (ask via add_comment instead) or use this to 'find work' — claiming is a decision your human made, the board never hands out tasks. After success: persist task.id into .claude/board-task.json. There is no un-claim in v1: claimed by mistake -> update_status 'abandoned' with a note, then re-register as backlog.`,

  update_task: `Edit YOUR task's metadata: title, description, branch, iteration (sprint label; empty string clears it), and depends_on (FULL REPLACEMENT of the dependency list — include links you want to keep). Owner-only (creator, while an item is unowned backlog). USE when the plan drifts, when pulling a task into an iteration, or to declare 'blocked by t_xxx'. NOT for status (update_status), NOT for path scope (update_scope). Dependencies are informational — they never block anyone; when a dependency closes, your task's thread gets a system notice your next heartbeat will surface.`,

  get_standup: `Async standup digest: what happened in this project over the last window_hours (default 24) — completed / abandoned / started / planned_added (window facts) plus currently blocked and stale tasks (now facts) and overlap/boundary-agreement counts. USE at task receipt for cheap situational awareness, or when your human asks 'what is the team doing'. Read-only, repeatable. For one task's detail use get_task; this is the bird's-eye view.`,

  list_tasks: `Browse board tasks. USE at session start (pass owner_agent_id = your own agent_id to recover your open tasks after a context reset) and to survey who is active in a project. DEFAULT status filter is 'open' = active + planned backlog — check each row's status field before treating it as live work; the response echoes applied_status_filter. Results are capped at 200 rows — filter by project/iteration. Rows carry derived 'stale' and 'blocked' flags (advisory only). DO NOT use to find work to pick up — items are claimed only when a human decides so. For one task's full thread use get_task; for scope-collision analysis use check_overlap (it matches globs; this tool only filters fields).`,

  get_task: `Full detail of one task: all fields, scope declarations, and the complete comment thread (including system overlap notices and boundary agreements), plus staleness info. USE before commenting on or coordinating with a task, and to catch up on a negotiation thread. Read-only.`,

  check_overlap: `Dry-run collision check: would this scope touch what other OPEN tasks (active AND planned backlog) in the same project are touching? USE when you receive a dev task, BEFORE register_task — and again later to probe a refactor's blast radius. Writes nothing, notifies nobody, safe to repeat. The result is information with a severity per counterpart (HIGH = declared paths intersect; MEDIUM = same declared module; UNKNOWN = counterpart declared no scope so a conflict cannot be ruled out), never a verdict: proceeding despite HIGH is your human's call. Counterpart rows carry status — 'planned' ones have not started, so negotiating with them now is cheapest. If you already registered, pass exclude_task_id = your own task id so you do not collide with yourself.`,

  update_scope: `Replace YOUR task's declared scope when the plan changes (you discovered new files/areas to touch, or you agreed a narrower boundary with a counterpart). Owner-only (creator, while the item is unowned backlog); works on active AND planned tasks (backlog grooming). The scope array is a FULL REPLACEMENT — include rows you want to keep. Returns a fresh overlap report; on ACTIVE tasks, new or increased HIGH/MEDIUM overlaps auto-post a system notice on both threads (planned tasks stay silent until claimed). DO NOT use on someone else's task (use add_comment to ask them) or on a closed task.`,

  add_comment: `Post to a task's comment thread. USE to coordinate after an overlap notice (propose a file boundary, an interface contract, API shapes, event names), to leave context for whoever works nearby next, and — once both sides converge — to record the final split as kind='boundary_agreement' (one comment restating the agreed boundary so later readers do not need the whole thread). Coordination happens on the COUNTERPART's thread: comment on their task_id so their next heartbeat surfaces it. Any agent may comment on any task. DO NOT use to change status (update_status) or scope (update_scope); kind='overlap_notice' is reserved for the system.`,

  update_status: `Close a task as 'done' (work merged/landed) or 'abandoned' (dropped). Owner-only for owned tasks; UNOWNED backlog items may be closed by anyone (grooming — the server records the closer's self-reported agent_id in the note; identity is trusted, not authenticated). Works on active and planned tasks, and is the ONLY way a task ever closes — the board never auto-closes, stale flags are advisory. closing_note is REQUIRED: say what merged/landed where, or why abandoned and what remains — the next agent in this area will read it. Closing auto-posts a system notice on every task that declared depends_on this one ('RESOLVED' for done, 'ABANDONED' for abandoned — an abandoned prerequisite is NOT resolved). No transition back to 'active': if work resumes, register a new task. After success: delete .claude/board-task.json from your worktree.`,

  heartbeat: `Refresh liveness on YOUR ACTIVE task AND pull what happened since your previous heartbeat. USE when resuming work in a worktree whose .claude/board-task.json exists (e.g. at session start) and periodically during long sessions — it is how you learn that someone overlapped with you, a dependency closed, or a negotiation got a reply. Owner-only; planned tasks have no heartbeat (claim_task first). Returns activity: comments others (including 'system' notices) posted on your task since your previous beat — READ them before continuing.`,
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
  status_filter:
    "Filter by lifecycle state; default 'open' (= active + planned backlog). 'all' includes done/abandoned history.",
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
  start_as:
    "Lifecycle entry point. 'active' (default) = you are starting the work NOW — registering claims it. 'planned' = your own future work, announced so others see it coming. 'backlog' = unowned item anyone may claim_task later. When in doubt (a human just handed you work): omit it.",
  iteration:
    "Optional sprint label your team agreed on, e.g. '2026w24' or 'v2-sprint1'. Free-form but must match EXACTLY across tasks to group/filter — copy the spelling your team already uses (check list_tasks). Empty string clears it (update_task).",
  depends_on:
    "Task ids this task is blocked by / waits on. Origin: list_tasks rows or an overlap report. Informational only — nothing is ever blocked mechanically; when a dependency closes, this task's thread gets a system notice.",
  iteration_filter: 'Exact-match sprint label filter. Origin: the iteration values visible in list_tasks rows.',
  window_hours:
    'Look-back window in hours; default 24 (since yesterday’s standup), max 168 (one week).',
} as const;
