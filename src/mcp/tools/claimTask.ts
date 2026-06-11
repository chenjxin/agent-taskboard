import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import type { OverlapReport, ScopeRowInput } from '../../core/types.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { commentsByTask, insertComment, SYSTEM_AUTHOR } from '../../db/repo/comments.js';
import { claimTask, getTask } from '../../db/repo/tasks.js';
import { scopesByTask } from '../../db/repo/scopes.js';
import { newIdentityHint } from '../cores.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { claimTaskShape } from '../schemas.js';
import { buildOverlapReport, ok, postSymmetricNotices, runTool } from './shared.js';

export function registerClaimTask(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'claim_task',
    {
      title: 'Claim a planned/backlog task (start working on it)',
      description: TOOL_DESCRIPTIONS.claim_task,
      inputSchema: claimTaskShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        const task = getTask(deps.db, args.task_id);
        if (!task) throw new BoardError('TASK_NOT_FOUND', `No task with id '${args.task_id}'.`);
        if (task.status === 'done' || task.status === 'abandoned') {
          throw new BoardError('TASK_ALREADY_CLOSED', `Task '${task.id}' is ${task.status}.`);
        }
        if (task.status === 'fixed') {
          throw new BoardError(
            'TASK_ALREADY_CLAIMED',
            `Task '${task.id}' is a fixed bug awaiting regression verification — not claimable.`,
            "Verify it instead: update_bug_state with event 'verify_pass' or 'verify_fail'.",
          );
        }
        if (task.status === 'active') {
          // Active tasks always have an owner (DB CHECK: status='active' => owner NOT NULL).
          throw new BoardError(
            'TASK_ALREADY_CLAIMED',
            `Task '${task.id}' is already active, owned by ${task.owner_agent_id as string}.`,
          );
        }
        if (task.owner_agent_id !== null && task.owner_agent_id !== args.agent_id) {
          throw new BoardError(
            'NOT_TASK_OWNER',
            `Task '${task.id}' is ${task.owner_agent_id}'s planned work — claiming it would take it from them.`,
            `Use add_comment on '${task.id}' to coordinate with ${task.owner_agent_id} instead of claiming.`,
          );
        }

        const scopeRows = scopesByTask(deps.db, task.id);
        const scope: ScopeRowInput[] = scopeRows.map((s) => ({
          path_glob: s.path_glob,
          module: s.module,
          note: s.note,
        }));
        const identityHint = newIdentityHint(deps, args.agent_id);
        let report!: OverlapReport;
        deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          if (!claimTask(deps.db, task.id, args.agent_id, now)) {
            throw new BoardError('TASK_ALREADY_CLAIMED', `Task '${task.id}' was claimed concurrently.`);
          }
          insertComment(
            deps.db,
            task.id,
            SYSTEM_AUTHOR,
            'comment',
            `Claimed by ${args.agent_id} — task is now active.`,
            now,
          );
          // The scope collides NOW: this is the moment symmetric overlap notices fire
          // (planned registration stays silent by design).
          report = buildOverlapReport(deps, task.project, scope, task.id, now, args.agent_id);
          postSymmetricNotices(
            deps.db,
            { taskId: task.id, title: task.title, owner: args.agent_id, branch: task.branch },
            report,
            now,
          );
        })();

        return ok({
          task: getTask(deps.db, task.id),
          scopes: scope,
          // Everything said while this sat in the backlog — the heartbeat cursor
          // starts at claim time, so this response is the only delivery channel.
          thread: commentsByTask(deps.db, task.id),
          warnings: { new_identity_hint: identityHint },
          overlap_report: report,
          next_step: `Persist {"task_id":"${task.id}","project":"${task.project}"} to .claude/board-task.json in your worktree. READ the thread above (pre-claim negotiation lives there), then act on overlap_report before writing code in shared paths.`,
        });
      }),
  );
}
