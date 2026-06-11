import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeProjectSlug } from '../../core/slug.js';
import { hoursSince, isStale } from '../../core/staleness.js';
import { blockingDeps } from '../../core/standup.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { countByTask } from '../../db/repo/comments.js';
import { depInfosForTasks } from '../../db/repo/deps.js';
import { scopesByTasks } from '../../db/repo/scopes.js';
import { listTasks } from '../../db/repo/tasks.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { listTasksShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

const ROW_CAP = 200;

export function registerListTasks(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'list_tasks',
    {
      title: 'Browse board tasks',
      description: TOOL_DESCRIPTIONS.list_tasks,
      inputSchema: listTasksShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        upsertAgent(deps.db, args.agent_id, now);
        const project = args.project ? normalizeProjectSlug(args.project).slug : undefined;
        const appliedStatus = args.status ?? 'open';
        const rows = listTasks(deps.db, {
          project,
          status: appliedStatus,
          ownerAgentId: args.owner_agent_id,
          createdByAgentId: args.created_by,
          type: args.type,
          iteration: args.iteration,
          limit: ROW_CAP,
        });
        const scopeMap = scopesByTasks(
          deps.db,
          rows.map((t) => t.id),
        );
        const depsMap = depInfosForTasks(
          deps.db,
          rows.map((t) => t.id),
        );
        const tasks = rows.map((t) => {
          const taskDeps = depsMap.get(t.id) ?? [];
          return {
            ...t,
            stale: t.status === 'active' && isStale(t.last_heartbeat_at, deps.staleTtlHours, now),
            hours_since_heartbeat: hoursSince(t.last_heartbeat_at, now),
            scopes: (scopeMap.get(t.id) ?? []).map((s) => ({
              path_glob: s.path_glob,
              module: s.module,
              note: s.note,
            })),
            depends_on: taskDeps,
            blocked: blockingDeps(taskDeps).length > 0,
            comment_count: countByTask(deps.db, t.id),
          };
        });
        return ok({
          tasks,
          count: tasks.length,
          applied_status_filter: appliedStatus,
          stale_ttl_hours: deps.staleTtlHours,
          hint:
            tasks.length === ROW_CAP
              ? `Result capped at ${ROW_CAP} rows — filter by project (and/or owner_agent_id, type, iteration).`
              : appliedStatus === 'open'
                ? "Includes 'planned' backlog and 'fixed' (bug awaiting verification) rows — check each row's status before treating it as live work."
                : null,
        });
      }),
  );
}
