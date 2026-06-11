import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { depNoticeFirstLine, insertComment, SYSTEM_AUTHOR } from '../../db/repo/comments.js';
import { dependentsOf } from '../../db/repo/deps.js';
import { getTask, setStatus } from '../../db/repo/tasks.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { updateStatusShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

export function registerUpdateStatus(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'update_status',
    {
      title: 'Close a task (done | abandoned)',
      description: TOOL_DESCRIPTIONS.update_status,
      inputSchema: updateStatusShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        let closingNote = (args.closing_note ?? '').trim();
        if (closingNote.length === 0) {
          throw new BoardError(
            'VALIDATION_ERROR',
            'closing_note is required.',
            'Say what merged/landed where, or why the task was abandoned and what remains — the next agent working in this area will read it.',
          );
        }
        const task = getTask(deps.db, args.task_id);
        if (!task) throw new BoardError('TASK_NOT_FOUND', `No task with id '${args.task_id}'.`);
        if (task.status === 'done' || task.status === 'abandoned') {
          throw new BoardError('TASK_ALREADY_CLOSED', `Task '${task.id}' is already ${task.status}.`);
        }
        // Owned tasks: owner only. Unowned backlog: anyone may groom it — the
        // server records who, so the audit trail survives in the closing note.
        if (task.owner_agent_id !== null && task.owner_agent_id !== args.agent_id) {
          throw new BoardError(
            'NOT_TASK_OWNER',
            `Task '${task.id}' is owned by ${task.owner_agent_id}, not you (${args.agent_id}).`,
          );
        }
        if (task.owner_agent_id === null) {
          closingNote = `[closed by ${args.agent_id}] ${closingNote}`;
        }

        const status = args.status;
        // Read dependents INSIDE the transaction: a second WAL writer could
        // close one between a pre-read and the writes.
        const dependents = deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          setStatus(deps.db, task.id, status, closingNote, now);
          const open = dependentsOf(deps.db, task.id).filter(
            (d) => d.status === 'planned' || d.status === 'active',
          );
          for (const dep of open) {
            insertComment(
              deps.db,
              dep.task_id,
              SYSTEM_AUTHOR,
              'dependency_notice',
              `${depNoticeFirstLine(status, task.id)}\nYour dependency '${task.title}' (${task.id}) was closed as ${status.toUpperCase()}${
                status === 'abandoned' ? ' — the prerequisite work was NOT completed' : ''
              }. Closing note: ${closingNote}`,
              now,
            );
          }
          return open;
        })();

        return ok({
          ok: true,
          task: getTask(deps.db, task.id),
          dependents_notified: dependents.map((d) => d.task_id),
          next_step: 'Delete .claude/board-task.json from your worktree.',
        });
      }),
  );
}
