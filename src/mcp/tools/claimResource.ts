import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { deleteClaim, liveClaim, upsertClaim } from '../../db/repo/resources.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { claimResourceShape, releaseResourceShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

export function registerClaimResource(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'claim_resource',
    {
      title: 'Declare an exclusive hold on a shared resource',
      description: TOOL_DESCRIPTIONS.claim_resource,
      inputSchema: claimResourceShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        const until = now + Math.round(args.hours * 3_600_000);
        const claim = deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          const existing = liveClaim(deps.db, args.project, args.name, now);
          if (existing && existing.holder_agent_id !== args.agent_id) {
            throw new BoardError(
              'RESOURCE_HELD',
              `'${args.name}' in ${args.project} is held by ${existing.holder_agent_id} until ` +
                `${new Date(existing.until).toISOString()}${existing.note ? ` — "${existing.note}"` : ''}.`,
            );
          }
          return upsertClaim(deps.db, args.project, args.name, args.agent_id, until, args.note ?? null, now);
        })();
        return ok({
          ok: true,
          claim,
          extended: claim.claimed_at < now,
          next_step:
            'The hold is now visible in get_standup and on the board. It is a DECLARATION — actually configure/repoint the resource yourself, and release_resource when done early.',
        });
      }),
  );

  server.registerTool(
    'release_resource',
    {
      title: 'Release a shared-resource claim you hold',
      description: TOOL_DESCRIPTIONS.release_resource,
      inputSchema: releaseResourceShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          const existing = liveClaim(deps.db, args.project, args.name, now);
          if (!existing) {
            throw new BoardError(
              'RESOURCE_NOT_FOUND',
              `No live claim on '${args.name}' in ${args.project} — it may have already expired.`,
            );
          }
          if (existing.holder_agent_id !== args.agent_id) {
            throw new BoardError(
              'NOT_RESOURCE_HOLDER',
              `'${args.name}' is held by ${existing.holder_agent_id}, not you (${args.agent_id}).`,
            );
          }
          deleteClaim(deps.db, args.project, args.name);
        })();
        return ok({ ok: true, released: args.name });
      }),
  );
}
