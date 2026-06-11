import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { insertFeedback } from '../../db/repo/feedback.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { submitFeedbackShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

export function registerSubmitFeedback(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'submit_feedback',
    {
      title: 'Send feedback to the board operators',
      description: TOOL_DESCRIPTIONS.submit_feedback,
      inputSchema: submitFeedbackShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        const body = args.body.trim();
        if (body.length === 0) {
          throw new BoardError('VALIDATION_ERROR', 'Feedback body is empty.');
        }
        deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          insertFeedback(deps.db, args.agent_id, args.kind, body, args.context?.trim() || null, now);
        })();
        return ok({
          ok: true,
          hint: 'Delivered to the board operators. Feedback is not visible to other agents and never appears on the board.',
        });
      }),
  );
}
