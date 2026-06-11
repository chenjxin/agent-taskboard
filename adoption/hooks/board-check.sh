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
if [ "${1:-}" = "--receipt" ]; then
  if [ ! -f "$ROOT/.claude/board-task.json" ]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"提醒:本工作树没有登记看板任务(.claude/board-task.json 不存在)。若这是新开发任务,先 check_overlap 再 register_task。"}}'
  fi
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
