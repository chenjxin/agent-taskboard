import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import type { OverlapReport } from '../../core/types.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { replaceScopeRows } from '../../db/repo/scopes.js';
import { getTask, touchUpdated } from '../../db/repo/tasks.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { updateScopeShape } from '../schemas.js';
import {
  buildOverlapReport,
  effectiveOwner,
  ok,
  postSymmetricNotices,
  runTool,
  validateScopeRows,
} from './shared.js';

export function registerUpdateScope(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'update_scope',
    {
      title: "Replace your task's declared scope",
      description: TOOL_DESCRIPTIONS.update_scope,
      inputSchema: updateScopeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        validateScopeRows(args.scope);
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

        let report!: OverlapReport;
        deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          replaceScopeRows(deps.db, task.id, args.scope);
          touchUpdated(deps.db, task.id, now);
          report = buildOverlapReport(deps, task.project, args.scope, task.id, now);
          // Planned tasks groom silently; notices fire only for live (active) work.
          if (task.status === 'active') {
            postSymmetricNotices(
              deps.db,
              { taskId: task.id, title: task.title, owner: effectiveOwner(task), branch: task.branch },
              report,
              now,
            );
          }
        })();

        return ok({
          task: getTask(deps.db, task.id),
          warnings: {
            broad_globs: report.broad_globs,
            no_scope_warning:
              args.scope.length === 0
                ? "Scope cleared: this task now appears as UNKNOWN to every teammate's overlap check."
                : null,
          },
          overlap_report: report,
        });
      }),
  );
}
