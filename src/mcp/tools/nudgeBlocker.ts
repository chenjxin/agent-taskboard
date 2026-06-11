import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BoardError } from '../../core/errors.js';
import { upsertAgent } from '../../db/repo/agents.js';
import { insertComment } from '../../db/repo/comments.js';
import { depInfos } from '../../db/repo/deps.js';
import { getTask } from '../../db/repo/tasks.js';
import type { BoardDeps } from '../deps.js';
import { TOOL_DESCRIPTIONS } from '../descriptions.js';
import { nudgeBlockerShape } from '../schemas.js';
import { ok, runTool } from './shared.js';

const COOLDOWN_MS = 24 * 3_600_000;
const NUDGE_PREFIX = 'NUDGE';

export function registerNudgeBlocker(server: McpServer, deps: BoardDeps): void {
  server.registerTool(
    'nudge_blocker',
    {
      title: 'Nudge the owner of a task that blocks yours',
      description: TOOL_DESCRIPTIONS.nudge_blocker,
      inputSchema: nudgeBlockerShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      runTool(() => {
        const now = deps.now();
        const mine = getTask(deps.db, args.task_id);
        if (!mine) throw new BoardError('TASK_NOT_FOUND', `No task with id '${args.task_id}'.`);
        if (mine.owner_agent_id !== args.agent_id) {
          throw new BoardError(
            'NOT_TASK_OWNER',
            `Task '${mine.id}' is owned by ${mine.owner_agent_id ?? 'nobody'}, not you (${args.agent_id}).`,
          );
        }
        const blocker = getTask(deps.db, args.blocker_task_id);
        if (!blocker) throw new BoardError('TASK_NOT_FOUND', `No task with id '${args.blocker_task_id}'.`);
        // Eligibility: a REAL declared dependency edge, and the blocker still open.
        const edge = depInfos(deps.db, mine.id).find((d) => d.task_id === blocker.id);
        if (!edge) {
          throw new BoardError(
            'NOT_A_DEPENDENT',
            `Task '${mine.id}' does not declare depends_on '${blocker.id}'.`,
          );
        }
        if (blocker.status === 'done' || blocker.status === 'abandoned') {
          throw new BoardError(
            'TASK_ALREADY_CLOSED',
            `Blocker '${blocker.id}' is already ${blocker.status} — nothing to nudge. heartbeat should have delivered the dependency notice.`,
          );
        }

        const blockedHours = Math.max(1, Math.round((now - mine.created_at) / 3_600_000));
        const body =
          `${NUDGE_PREFIX} from dependent task: '${mine.title}' (${mine.id}, owner ${args.agent_id}) ` +
          `declares depends_on this task and has been waiting ~${blockedHours}h. ` +
          `Current state here: ${blocker.status}` +
          (blocker.status === 'waiting' && blocker.waiting_on ? ` (waiting on: ${blocker.waiting_on})` : '') +
          `. A progress note or an ETA on this thread would unblock their planning.` +
          (args.note ? ` Dependent adds: ${args.note}` : '');

        deps.db.transaction(() => {
          upsertAgent(deps.db, args.agent_id, now);
          // Cooldown: one nudge per (blocker, dependent) pair per 24h. Detected
          // from the composed comments themselves — no extra table.
          const likeId = mine.id.replace(/[\\%_]/g, (c) => `\\${c}`); // '_' is a LIKE wildcard
          const recent = deps.db
            .prepare(
              `SELECT 1 FROM comments WHERE task_id = ? AND kind = 'dependency_notice'
               AND body LIKE ? ESCAPE '\\' AND created_at > ? LIMIT 1`,
            )
            .get(blocker.id, `${NUDGE_PREFIX} from dependent task: %(${likeId},%`, now - COOLDOWN_MS);
          if (recent) {
            throw new BoardError(
              'NUDGE_COOLDOWN',
              `'${blocker.id}' was already nudged for '${mine.id}' within the last 24h.`,
            );
          }
          insertComment(deps.db, blocker.id, 'system', 'dependency_notice', body, now);
        })();

        return ok({
          ok: true,
          posted_on: blocker.id,
          delivery:
            `${blocker.owner_agent_id ?? 'unclaimed (no owner to nudge — consider claiming it or asking your human to find an owner)'} ` +
            `will see it at their next heartbeat or session start. Nothing was interrupted and nothing escalates automatically.`,
        });
      }),
  );
}
