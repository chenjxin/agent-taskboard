import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { depInfos, replaceDeps } from '../../db/repo/deps.js';
import { getTask, patchTask } from '../../db/repo/tasks.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { updateTaskShape } from '../schemas.js';
import { effectiveOwner, ok, runTool, validateDeps } from './shared.js';

export function registerUpdateTask(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'update_task',
    {
      title: "Edit your task's metadata (title/description/branch/iteration/deps)",
      description: TOOL_DESCRIPTIONS.update_task,
      inputSchema: updateTaskShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        const hasPatch =
          args.title !== undefined ||
          args.description !== undefined ||
          args.branch !== undefined ||
          args.iteration !== undefined ||
          args.severity !== undefined ||
          args.depends_on !== undefined;
        if (!hasPatch) {
          throw new BoardError(
            'VALIDATION_ERROR',
            'Nothing to update — provide at least one of title/description/branch/iteration/severity/depends_on.',
          );
        }
        const task = getTask(deps.db, args.task_id);
        if (!task) throw new BoardError('TASK_NOT_FOUND', `No task with id '${args.task_id}'.`);
        if (task.status === 'done' || task.status === 'abandoned') {
          throw new BoardError('TASK_ALREADY_CLOSED', `Task '${task.id}' is ${task.status}.`);
        }
        if (effectiveOwner(task) !== args.agent_id) {
          throw new BoardError(
            'NOT_TASK_OWNER',
            `Task '${task.id}' belongs to ${effectiveOwner(task)}, not you (${args.agent_id}).`,
          );
        }
        deps.db.transaction(() => {
          // Validation inside the transaction (matching registerTask): the cycle
          // and existence checks must not go stale before replaceDeps writes.
          if (args.depends_on !== undefined) validateDeps(deps.db, task.id, args.depends_on);
          upsertAgent(deps.db, args.agent_id, now);
          patchTask(
            deps.db,
            task.id,
            {
              title: args.title,
              description: args.description,
              branch: args.branch,
              severity: args.severity,
              // Empty string clears the iteration label.
              iteration: args.iteration === undefined ? undefined : args.iteration.trim() || null,
            },
            now,
          );
          if (args.depends_on !== undefined) replaceDeps(deps.db, task.id, args.depends_on, now);
        })();

        const finalDeps = depInfos(deps.db, task.id);
        const closed = finalDeps.filter((d) => d.status === 'done' || d.status === 'abandoned');
        return ok({
          task: getTask(deps.db, task.id),
          depends_on: finalDeps,
          warnings: {
            already_closed_deps:
              closed.length > 0
                ? `Dependency task(s) already closed: ${closed.map((d) => `${d.task_id} (${d.status})`).join(', ')} — an abandoned prerequisite is NOT resolved work.`
                : null,
          },
        });
      }),
  );
}
