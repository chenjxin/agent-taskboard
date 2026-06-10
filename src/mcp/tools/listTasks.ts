import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeProjectSlug } from '../../core/slug.js';
import { hoursSince, isStale } from '../../core/staleness.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { countByTask } from '../../db/repo/comments.js';
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
        const rows = listTasks(deps.db, {
          project,
          status: args.status ?? 'active',
          ownerAgentId: args.owner_agent_id,
          limit: ROW_CAP,
        });
        const scopeMap = scopesByTasks(
          deps.db,
          rows.map((t) => t.id),
        );
        const tasks = rows.map((t) => ({
          ...t,
          stale: t.status === 'active' && isStale(t.last_heartbeat_at, deps.staleTtlHours, now),
          hours_since_heartbeat: hoursSince(t.last_heartbeat_at, now),
          scopes: (scopeMap.get(t.id) ?? []).map((s) => ({
            path_glob: s.path_glob,
            module: s.module,
            note: s.note,
          })),
          comment_count: countByTask(deps.db, t.id),
        }));
        return ok({
          tasks,
          count: tasks.length,
          stale_ttl_hours: deps.staleTtlHours,
          hint:
            tasks.length === ROW_CAP
              ? `Result capped at ${ROW_CAP} rows — filter by project (and/or owner_agent_id).`
              : null,
        });
      }),
  );
}
