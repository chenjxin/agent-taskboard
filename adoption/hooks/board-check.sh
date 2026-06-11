#!/usr/bin/env bash
# board-check.sh — Claude Code hook for the agent task board.
#
# Modes:
#   (no args)   SessionStart: inject a board-protocol reminder plus this
#               agent's open tasks (raw JSON from /api/board?owner=...).
#   --receipt   UserPromptSubmit: one-line reminder when the worktree has
#               no registered board task; silent otherwise.
#
# Env:
#   BOARD_URL       Board base URL (default: http://nas.lan:8765).
#   AGENT_BOARD_ID  This agent's board identity ('<human>/<agent>'). If unset,
#                   read from the 'agent_id: ...' line in the repo root CLAUDE.md.
#
# Failure policy: the board being down must NEVER break a session.
# Every error path prints nothing and exits 0.

set -u

BOARD_URL="${BOARD_URL:-http://nas.lan:8765}"
# Only plain http(s) URLs — blocks curl flag injection via a hostile env var.
case "$BOARD_URL" in
  http://*|https://*) ;;
  *) exit 0 ;;
esac

project_root() {
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    printf '%s' "$CLAUDE_PROJECT_DIR"
  else
    git rev-parse --show-toplevel 2>/dev/null || pwd
  fi
}

ROOT="$(project_root)"

# --- --receipt mode (UserPromptSubmit) ---------------------------------------
# No task file -> registration reminder. Task file present -> scope-drift check:
# compare `git status` paths against the task's declared globs and nudge
# update_scope when the real diff escaped the declared map (plans drift within
# minutes; overlap checks navigate a stale map otherwise). Silent when clean,
# silent on ANY failure — the board must never break a session.
if [ "${1:-}" = "--receipt" ]; then
  if [ ! -f "$ROOT/.claude/board-task.json" ]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"提醒:本工作树没有登记看板任务(.claude/board-task.json 不存在)。若这是新开发任务,先 check_overlap 再 register_task。"}}'
    exit 0
  fi

  command -v git >/dev/null 2>&1 || exit 0
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

  TASK_ID="$(sed -n 's/.*"task_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/.claude/board-task.json" | head -1)"
  TASK_PROJECT="$(sed -n 's/.*"project"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/.claude/board-task.json" | head -1)"
  [ -n "$TASK_ID" ] || exit 0
  # TASK_ID is interpolated into the python -c string below — enforce the
  # server-generated shape so a tampered board-task.json cannot inject code.
  case "$TASK_ID" in
    t_[a-z0-9]*) ;;
    *) exit 0 ;;
  esac
  case "$TASK_ID" in
    *[!a-z0-9_]*) exit 0 ;;
  esac

  # Declared path globs for this task, via the board JSON (2s timeout, fail silent).
  board_json="$(curl --noproxy '*' -m 2 -sf -G "$BOARD_URL/api/board" \
    --data-urlencode "project=$TASK_PROJECT" 2>/dev/null)" || exit 0
  [ -n "$board_json" ] || exit 0
  globs="$(printf '%s' "$board_json" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    tid = '$TASK_ID'
    for p in data.get('projects', []):
        for t in p.get('tasks', []):
            if t.get('id') == tid:
                for s in t.get('scopes', []):
                    g = s.get('path_glob')
                    if g:
                        print(g)
except Exception:
    pass
" 2>/dev/null)" || exit 0
  # Module-only scope (standing roles / undeclared) -> path drift is undefined; stay silent.
  [ -n "$globs" ] || exit 0

  # Changed paths (staged + unstaged + untracked), repo-relative. -uall expands
  # untracked DIRECTORIES into their files — porcelain otherwise collapses a
  # fully-untracked dir to 'dir/', which no file-glob would ever cover.
  # head -200 caps the scan on huge trees (drift detection degrades to a sample);
  # the trailing sed unwraps porcelain's quoting of paths with spaces.
  changed="$(git -C "$ROOT" status --porcelain -uall 2>/dev/null | head -200 \
    | sed -e 's/^...//' -e 's/.* -> //' -e 's/^"\(.*\)"$/\1/')" || exit 0
  [ -n "$changed" ] || exit 0

  # Coverage test per file: bash case patterns ('**'->'*' since case '*' crosses '/';
  # a bare dir covers itself and its subtree). Bias matches the board: prefer
  # reporting drift over missing it.
  drifted=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    covered=0
    while IFS= read -r g; do
      [ -n "$g" ] || continue
      pat="$(printf '%s' "$g" | sed 's/\*\*/\*/g')"
      case "$f" in
        $pat|$pat/*|"$g") covered=1; break ;;
      esac
    done <<EOF_GLOBS
$globs
EOF_GLOBS
    [ "$covered" = "1" ] || drifted="$drifted $f"
  done <<EOF_CHANGED
$changed
EOF_CHANGED

  drifted="$(printf '%s' "$drifted" | sed 's/^ *//')"
  [ -n "$drifted" ] || exit 0

  msg="scope 漂移提醒:以下已改动文件不在任务 $TASK_ID 声明的 scope 内 → $drifted 。若它们属于本任务,请调用 update_scope 补充声明(注意是全量替换,带上要保留的行);重叠检查正按过期地图导航。"
  printf '%s' "$msg" | python3 -c "
import sys, json
print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': sys.stdin.read()}}, ensure_ascii=False))
" 2>/dev/null || exit 0
  exit 0
fi

# --- SessionStart mode ---------------------------------------------------------

# Resolve agent identity: env var first, then the CLAUDE.md declaration line.
AGENT_ID="${AGENT_BOARD_ID:-}"
if [ -z "$AGENT_ID" ] && [ -f "$ROOT/CLAUDE.md" ]; then
  AGENT_ID="$(grep -m1 -E '^agent_id:' "$ROOT/CLAUDE.md" 2>/dev/null \
    | sed -e 's/^agent_id:[[:space:]]*//' -e 's/[[:space:]]*$//')"
fi
if [ -z "$AGENT_ID" ]; then
  exit 0
fi

# Derive project slug: basename of origin URL, strip .git, lowercase;
# fallback to the repo directory name when there is no remote.
remote_url="$(git remote get-url origin 2>/dev/null || true)"
if [ -n "$remote_url" ]; then
  slug="$(basename "$remote_url")"
  slug="${slug%.git}"
else
  slug="$(basename "$ROOT")"
fi
slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]')"

# Fetch this agent's open tasks. 2s timeout; ANY failure -> silent success.
body="$(curl --noproxy '*' -m 2 -sf -G "$BOARD_URL/api/board" \
  --data-urlencode "owner=$AGENT_ID" 2>/dev/null)" || exit 0
if [ -z "$body" ]; then
  exit 0
fi

reminder="任务看板协议提醒(agent_id: $AGENT_ID,当前项目 slug: $slug):接到新开发任务时,写码前先 check_overlap(project + 计划触碰的路径),再 register_task 登记认领并把 task id 写入 .claude/board-task.json;续作已登记的工作树先 heartbeat 并阅读返回的 activity;完成后 update_status(done|abandoned)+ closing_note。看板只提供信息,从不分派任务。你在板上的未关闭任务(原始 JSON)如下:"

# Build the hook JSON safely: jq if available, else python3, else skip silently.
if command -v jq >/dev/null 2>&1; then
  printf '%s\n%s' "$reminder" "$body" \
    | jq -Rs '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:.}}' \
      2>/dev/null && exit 0
fi
if command -v python3 >/dev/null 2>&1; then
  printf '%s\n%s' "$reminder" "$body" \
    | python3 -c 'import json,sys;print(json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":sys.stdin.read()}},ensure_ascii=False))' \
      2>/dev/null && exit 0
fi

exit 0
