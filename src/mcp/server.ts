import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appVersion } from '../config.js';
import type { BoardDeps } from './deps.js';
import { SERVER_INSTRUCTIONS } from './descriptions.js';
import { registerAddComment } from './tools/addComment.js';
import { registerCheckOverlap } from './tools/checkOverlap.js';
import { registerClaimTask } from './tools/claimTask.js';
import { registerGetStandup } from './tools/getStandup.js';
import { registerGetTask } from './tools/getTask.js';
import { registerHeartbeat } from './tools/heartbeat.js';
import { registerListTasks } from './tools/listTasks.js';
import { registerRegisterTask } from './tools/registerTask.js';
import { registerUpdateScope } from './tools/updateScope.js';
import { registerUpdateStatus } from './tools/updateStatus.js';
import { registerUpdateTask } from './tools/updateTask.js';

/**
 * Build a fresh McpServer wired to the shared deps. Cheap by design: the
 * HTTP layer runs STATELESS Streamable HTTP and constructs one per request.
 */
export function buildMcpServer(deps: BoardDeps): McpServer {
  const server = new McpServer(
    { name: 'task-board', version: appVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerRegisterTask(server, deps);
  registerClaimTask(server, deps);
  registerListTasks(server, deps);
  registerGetTask(server, deps);
  registerCheckOverlap(server, deps);
  registerUpdateScope(server, deps);
  registerUpdateTask(server, deps);
  registerAddComment(server, deps);
  registerUpdateStatus(server, deps);
  registerHeartbeat(server, deps);
  registerGetStandup(server, deps);
  return server;
}
