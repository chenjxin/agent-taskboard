import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskCore } from '../cores.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { registerTaskShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

export function registerRegisterTask(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'register_task',
    {
      title: 'Put a task on the board (active = claim it now)',
      description: TOOL_DESCRIPTIONS.register_task,
      inputSchema: registerTaskShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => runTool(() => ok(registerTaskCore(deps, args))),
  );
}
