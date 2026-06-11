import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { getTask } from '../../db/repo/tasks.js';
import { closeTaskInTx } from '../cores.js';
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
        const dependents = deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          return closeTaskInTx(deps, task, status, closingNote, now);
        })();

        return ok({
          ok: true,
          task: getTask(deps.db, task.id),
          dependents_notified: dependents,
          warnings: {
            verification_skipped:
              task.type === 'bug' && status === 'done'
                ? "Bug closed WITHOUT the verification flow — no [verified by] audit trail. Next time: update_bug_state fix_ready, then someone verifies with verify_pass."
                : null,
          },
          next_step: 'Delete .claude/board-task.json from your worktree.',
          feedback_hint:
            'Optional: if anything about the BOARD was awkward during this task (or notably good), submit_feedback takes one sentence — it goes only to the board operators.',
        });
      }),
  );
}
