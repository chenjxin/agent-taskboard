import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { computeStandup } from '../../core/standup.js';
import { normalizeProjectSlug } from '../../core/slug.js';
import type { Db } from '../../db/connection.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { commentKindCountsSince, urgentCommentsSince } from '../../db/repo/comments.js';
import { depInfosForTasks } from '../../db/repo/deps.js';
import { boardTasks } from '../../db/repo/tasks.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { getStandupShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

const ROW_CAP = 1000;

export interface StandupQuery {
  project?: string | undefined;
  iteration?: string | undefined;
  windowHours: number;
}

/** Shared by the get_standup tool and GET /api/standup. */
export function buildStandup(db: Db, staleTtlHours: number, now: number, query: StandupQuery) {
  const since = now - query.windowHours * 3_600_000;
  const tasks = boardTasks(db, since, ROW_CAP);
  return computeStandup({
    tasks,
    depsByTask: depInfosForTasks(
      db,
      tasks.map((t) => t.id),
    ),
    commentCounts: commentKindCountsSince(db, since),
    urgentComments: urgentCommentsSince(db, since),
    staleTtlHours,
    now,
    windowHours: query.windowHours,
    project: query.project,
    iteration: query.iteration,
  });
}

export function registerGetStandup(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'get_standup',
    {
      title: 'Async standup digest (what happened lately)',
      description: TOOL_DESCRIPTIONS.get_standup,
      inputSchema: getStandupShape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        upsertAgent(deps.db, args.agent_id, now);
        const report = buildStandup(deps.db, deps.staleTtlHours, now, {
          project: args.project ? normalizeProjectSlug(args.project).slug : undefined,
          iteration: args.iteration,
          windowHours: args.window_hours ?? 24,
        });
        return ok({
          standup: report,
          hint:
            report.alerts.length > 0
              ? `⚠ ${report.alerts.length} URGENT alert(s) at standup.alerts — read those FIRST.`
              : report.projects.length === 0
                ? 'No activity in the window (and no current blockers/stale tasks). Widen window_hours or drop filters if that surprises you.'
                : null,
        });
      }),
  );
}
