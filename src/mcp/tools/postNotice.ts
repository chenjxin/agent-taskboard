import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { insertNotice } from '../../db/repo/resources.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { postNoticeShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

const DEFAULT_TTL_HOURS = 72;

export function registerPostNotice(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'post_notice',
    {
      title: 'Broadcast a task-free announcement to a project',
      description: TOOL_DESCRIPTIONS.post_notice,
      inputSchema: postNoticeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        const ttl = args.ttl_hours ?? DEFAULT_TTL_HOURS;
        const notice = deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          return insertNotice(deps.db, args.project, args.agent_id, args.body.trim(), now, now + ttl * 3_600_000);
        })();
        return ok({
          ok: true,
          notice,
          next_step: `Visible at the top of get_standup and the board until ${new Date(notice.expires_at).toISOString()}. Pure FYI — nobody is interrupted; teammates see it at their next pull.`,
        });
      }),
  );
}
