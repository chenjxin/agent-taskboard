import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import { normalizeProjectSlug } from '../../core/slug.js';
import type { OverlapReport, ScopeRowInput, TaskRow } from '../../core/types.js';
import { newTaskId } from '../../db/ids.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { insertScopeRows } from '../../db/repo/scopes.js';
import { getTask, insertTask } from '../../db/repo/tasks.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { registerTaskShape } from '../schemas.js';
import { buildOverlapReport, ok, postSymmetricNotices, runTool, validateScopeRows } from './shared.js';

export function registerRegisterTask(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'register_task',
    {
      title: 'Register (claim) a task',
      description: TOOL_DESCRIPTIONS.register_task,
      inputSchema: registerTaskShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        const scope: ScopeRowInput[] = args.scope ?? [];
        validateScopeRows(scope);
        const { slug, changed } = normalizeProjectSlug(args.project);
        if (!slug) {
          throw new BoardError('VALIDATION_ERROR', `project '${args.project}' resolved to an empty slug`);
        }

        const id = newTaskId();
        let report!: OverlapReport;
        deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          const task: TaskRow = {
            id,
            project: slug,
            title: args.title,
            description: args.description ?? '',
            branch: args.branch ?? null,
            owner_agent_id: args.agent_id,
            status: 'active',
            closing_note: null,
            created_at: now,
            updated_at: now,
            closed_at: null,
            last_heartbeat_at: now,
          };
          insertTask(deps.db, task);
          insertScopeRows(deps.db, id, scope);
          report = buildOverlapReport(deps, slug, scope, id, now);
          postSymmetricNotices(
            deps.db,
            { taskId: id, title: args.title, owner: args.agent_id, branch: args.branch ?? null },
            report,
            now,
          );
        })();

        const ownOverlapping = report.counterparts.filter((c) => c.owner_agent_id === args.agent_id);
        return ok({
          task: getTask(deps.db, id) as TaskRow,
          normalized_project: { slug, changed },
          warnings: {
            duplicate_task_hint:
              ownOverlapping.length > 0
                ? `You already own ${ownOverlapping.length} other active overlapping task(s) in '${slug}': ${ownOverlapping
                    .map((c) => c.task_id)
                    .join(', ')}. Parallel worktrees are legitimate — make sure this is intentional, not a duplicate registration.`
                : null,
            broad_globs: report.broad_globs,
            did_you_mean: report.did_you_mean,
            no_scope_warning:
              scope.length === 0
                ? "No scope declared: this task appears as UNKNOWN to every teammate's overlap check. Call update_scope once you know which files you will touch."
                : null,
          },
          overlap_report: report,
          next_step: `Persist {"task_id":"${id}","project":"${slug}"} to .claude/board-task.json in your worktree (gitignored). Then act on overlap_report: HIGH/MEDIUM counterparts mean coordinate via add_comment BEFORE writing code in the shared paths.`,
        });
      }),
  );
}
