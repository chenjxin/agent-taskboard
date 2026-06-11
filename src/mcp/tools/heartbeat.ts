import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import type { CommentRow } from '../../core/types.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { commentsSince } from '../../db/repo/comments.js';
import { relatedBacklogForTask } from '../../db/repo/routing.js';
import { getTask, touchHeartbeat } from '../../db/repo/tasks.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { heartbeatShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

export function registerHeartbeat(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'heartbeat',
    {
      title: 'Refresh liveness + pull activity since your last beat',
      description: TOOL_DESCRIPTIONS.heartbeat,
      // Not readOnly (advances the activity cursor), not idempotent (each call moves the window).
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: heartbeatShape,
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        const task = getTask(deps.db, args.task_id);
        if (!task) throw new BoardError('TASK_NOT_FOUND', `No task with id '${args.task_id}'.`);
        // Status before ownership: a planned task may be unowned, and the right
        // hint there is "claim it", not a confusing owner mismatch.
        if (task.status === 'planned') {
          throw new BoardError('TASK_NOT_ACTIVE', `Task '${task.id}' is still planned — no heartbeat yet.`);
        }
        // 'fixed' bugs keep their heartbeat channel (verify_fail delivery), and
        // 'waiting' tasks keep theirs (how the owner notices the wait resolved).
        if (task.status !== 'active' && task.status !== 'fixed' && task.status !== 'waiting') {
          throw new BoardError(
            'TASK_ALREADY_CLOSED',
            `Task '${task.id}' is ${task.status} — closed tasks need no heartbeat.`,
          );
        }
        if (task.owner_agent_id !== args.agent_id) {
          throw new BoardError(
            'NOT_TASK_OWNER',
            `Task '${task.id}' is owned by ${task.owner_agent_id}, not you (${args.agent_id}).`,
          );
        }

        // Atomic read-old -> collect-activity -> advance-cursor: better-sqlite3
        // transactions are synchronous, so the race window is structurally closed.
        let activity: CommentRow[] = [];
        const previous = task.last_heartbeat_at;
        deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          activity = commentsSince(deps.db, task.id, previous, args.agent_id);
          touchHeartbeat(deps.db, task.id, now);
        })();

        const urgentCount = activity.filter((c) => c.urgent === 1).length;
        const relatedBacklog = relatedBacklogForTask(deps.db, task);
        return ok({
          ok: true,
          previous_heartbeat_at: previous,
          stale_ttl_hours: deps.staleTtlHours,
          activity,
          related_backlog: relatedBacklog,
          related_backlog_hint:
            relatedBacklog.length > 0
              ? `${relatedBacklog.length} unclaimed backlog bug(s) overlap THIS task's scope. Mention them to your human — claim_task ONLY if they say so; the board informs, it never assigns.`
              : null,
          activity_hint:
            urgentCount > 0
              ? `⚠ ${urgentCount} of these are marked URGENT — read those FIRST, before anything else in this turn.`
              : activity.length > 0
                ? 'READ these before continuing — they may include system overlap notices and boundary proposals from teammates.'
                : null,
        });
      }),
  );
}
