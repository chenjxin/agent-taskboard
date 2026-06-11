import { describe, expect, it } from 'vitest';
import type { CommentRow, TaskRow } from '../../src/core/types.js';
import type { StandupAlert } from '../../src/core/standup.js';
import { buildBoardData } from '../../src/web/boardData.js';
import { HOUR, makeTestBoard, registerArgs, T0 } from './helpers.js';

describe('urgent comment tier (pull-only escalation)', () => {
  it('tops standup alerts, the owner heartbeat hint, and the board payload', async () => {
    const b = await makeTestBoard();
    const reg = await b.callOk('register_task', registerArgs());
    const id = (reg['task'] as TaskRow).id;

    b.advance(HOUR);
    const posted = await b.callOk('add_comment', {
      agent_id: 'qa/claude',
      task_id: id,
      body: '部署级回归:4 个已验证修复在新部署中丢失',
      urgent: true,
    });
    expect(posted['urgent_note']).toContain('sparingly');
    await b.callOk('add_comment', { agent_id: 'qa/claude', task_id: id, body: '普通跟进留言' });

    // Standup: alerts at the top, project-filterable.
    const standup = await b.callOk('get_standup', { agent_id: 'carol/claude' });
    const alerts = (standup['standup'] as { alerts: StandupAlert[] }).alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.task_id).toBe(id);
    expect(alerts[0]!.body).toContain('部署级回归');
    expect(standup['hint']).toContain('URGENT');
    const filtered = await b.callOk('get_standup', { agent_id: 'carol/claude', project: 'elsewhere' });
    expect((filtered['standup'] as { alerts: StandupAlert[] }).alerts).toHaveLength(0);

    // Deliberate semantics: alerts are project-scoped but NOT iteration-scoped —
    // urgency transcends sprint boundaries.
    const iterFiltered = await b.callOk('get_standup', { agent_id: 'carol/claude', iteration: 'some-other-sprint' });
    expect((iterFiltered['standup'] as { alerts: StandupAlert[] }).alerts).toHaveLength(1);

    // Owner heartbeat: urgent items flip the hint to read-first.
    b.advance(HOUR);
    const beat = await b.callOk('heartbeat', { agent_id: 'alice/claude', task_id: id });
    expect(beat['activity_hint']).toContain('URGENT');
    expect((beat['activity'] as CommentRow[]).some((c) => c.urgent === 1)).toBe(true);

    // Board payload carries the flag for card styling.
    const board = buildBoardData(b.db, 8, T0 + 3 * HOUR, {});
    const task = board.projects[0]!.tasks[0]!;
    expect(task.recent_comments.some((c) => c.urgent === 1)).toBe(true);

    // Closed tasks drop out of the alerts feed (stale urgency fades with the task).
    await b.callOk('update_status', { agent_id: 'alice/claude', task_id: id, status: 'done', closing_note: 'x' });
    const after = await b.callOk('get_standup', { agent_id: 'carol/claude' });
    expect((after['standup'] as { alerts: StandupAlert[] }).alerts).toHaveLength(0);
  });
});
