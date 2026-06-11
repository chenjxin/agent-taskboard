import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import { hoursSince, isStale } from '../../core/staleness.js';
import { blockingDeps } from '../../core/standup.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { commentsByTask } from '../../db/repo/comments.js';
import { dependentsOf, depInfos } from '../../db/repo/deps.js';
import { scopesByTask } from '../../db/repo/scopes.js';
import { getTask } from '../../db/repo/tasks.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { getTaskShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

export function registerGetTask(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'get_task',
    {
      title: 'Full detail of one task',
      description: TOOL_DESCRIPTIONS.get_task,
      inputSchema: getTaskShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        upsertAgent(deps.db, args.agent_id, now);
        const task = getTask(deps.db, args.task_id);
        if (!task) {
          throw new BoardError('TASK_NOT_FOUND', `No task with id '${args.task_id}'.`);
        }
        const taskDeps = depInfos(deps.db, task.id);
        return ok({
          task,
          stale: task.status === 'active' && isStale(task.last_heartbeat_at, deps.staleTtlHours, now),
          hours_since_heartbeat: hoursSince(task.last_heartbeat_at, now),
          scopes: scopesByTask(deps.db, task.id).map((s) => ({
            path_glob: s.path_glob,
            module: s.module,
            note: s.note,
          })),
          depends_on: taskDeps,
          blocked: blockingDeps(taskDeps).length > 0,
          dependents: dependentsOf(deps.db, task.id),
          comments: commentsByTask(deps.db, task.id),
        });
      }),
  );
}
