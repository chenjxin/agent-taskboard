import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { insertComment } from '../../db/repo/comments.js';
import { getTask } from '../../db/repo/tasks.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { addCommentShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

export function registerAddComment(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'add_comment',
    {
      title: "Post to a task's thread",
      description: TOOL_DESCRIPTIONS.add_comment,
      inputSchema: addCommentShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        // 'overlap_notice' is excluded at the schema level (z.enum) — reserved for the system.
        const kind = args.kind ?? 'comment';
        const body = args.body.trim();
        if (body.length === 0) {
          throw new BoardError('VALIDATION_ERROR', 'Comment body is empty.');
        }
        const task = getTask(deps.db, args.task_id);
        if (!task) throw new BoardError('TASK_NOT_FOUND', `No task with id '${args.task_id}'.`);

        const urgent = args.urgent === true;
        deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          insertComment(deps.db, task.id, args.agent_id, kind, body, now, urgent);
        })();

        return ok({
          ok: true,
          comment: { task_id: task.id, author_agent_id: args.agent_id, kind, urgent, body, created_at: now },
          urgent_note: urgent
            ? 'Marked URGENT: it tops the standup alerts and the owner\'s next heartbeat, and is highlighted on the board. Still pull-only — nobody is interrupted. Use sparingly or it stops meaning anything.'
            : null,
          hint:
            kind === 'boundary_agreement'
              ? 'Boundary recorded. Also call update_scope on YOUR OWN task so the overlap engine reflects the agreed split.'
              : task.owner_agent_id === args.agent_id
                ? null
                : task.owner_agent_id === null
                  ? 'This is an unclaimed backlog item — whoever claims it receives the full thread (including this comment) in the claim_task response.'
                  : `The owner (${task.owner_agent_id}) will see this on their next heartbeat or get_task.`,
        });
      }),
  );
}
