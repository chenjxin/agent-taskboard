import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateBugStateCore } from '../cores.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { updateBugStateShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

export function registerUpdateBugState(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'update_bug_state',
    {
      title: 'Bug verification lifecycle (fix_ready | verify_pass | verify_fail)',
      description: TOOL_DESCRIPTIONS.update_bug_state,
      inputSchema: updateBugStateShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      runTool(() =>
        ok(
          updateBugStateCore(deps, {
            actor: args.agent_id,
            task_id: args.task_id,
            event: args.event,
            note: args.note,
            via: 'mcp',
          }),
        ),
      ),
  );
}
