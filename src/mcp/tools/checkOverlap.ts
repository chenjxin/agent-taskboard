import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import { normalizeProjectSlug } from '../../core/slug.js';
import { upsertAgent } from '../../db/repo/agents.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { checkOverlapShape } from '../schemas.js';
import { buildOverlapReport, ok, runTool, validateScopeRows } from './shared.js';

export function registerCheckOverlap(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'check_overlap',
    {
      title: 'Dry-run scope collision check',
      description: TOOL_DESCRIPTIONS.check_overlap,
      inputSchema: checkOverlapShape,
      // Dry-run guarantee: registers nothing, posts nothing. The agents-table
      // upsert below is presence telemetry, invisible to domain state.
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        const scope = args.scope ?? [];
        validateScopeRows(scope);
        const { slug, changed } = normalizeProjectSlug(args.project);
        if (!slug) {
          throw new BoardError('VALIDATION_ERROR', `project '${args.project}' resolved to an empty slug`);
        }
        upsertAgent(deps.db, args.agent_id, now);
        const report = buildOverlapReport(deps, slug, scope, args.exclude_task_id, now);
        return ok({
          normalized_project: { slug, changed },
          overlap_report: report,
          next_step:
            report.counterparts.length > 0
              ? 'This was a dry run — nothing was recorded and nobody was notified. When you start the work, call register_task with this scope; per-counterpart guidance is in overlap_report.counterparts[].next_step.'
              : 'No overlapping active tasks. When you start the work, call register_task with this scope so others can see you.',
        });
      }),
  );
}
