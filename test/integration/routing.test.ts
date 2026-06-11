import { describe, expect, it } from 'vitest';
import type { TaskRow } from '../../src/core/types.js';
import type { RelatedBacklogBug } from '../../src/db/repo/routing.js';
import { buildBoardData } from '../../src/web/boardData.js';
import { HOUR, makeTestBoard, registerArgs, T0 } from './helpers.js';

describe('information-tier bug routing (related_backlog)', () => {
  it('routes unclaimed bugs to agents whose historical scopes overlap — and only those', async () => {
    const b = await makeTestBoard();
    // alice built the auth module and already CLOSED that task — history is turf.
    const built = await b.callOk('register_task', registerArgs({
      scope: [{ path_glob: 'src/auth/**', module: 'auth' }],
    }));
    const builtId = (built['task'] as TaskRow).id;
    await b.callOk('update_status', {
      agent_id: 'alice/claude', task_id: builtId, status: 'done', closing_note: 'shipped',
    });

    b.advance(HOUR);
    // QA files an unclaimed bug on that module (module-only scope — standing-role style).
    const bug = await b.callOk('register_task', registerArgs({
      agent_id: 'qa/claude',
      title: 'auth: token refresh loops forever',
      type: 'bug',
      severity: 'high',
      start_as: 'backlog',
      scope: [{ module: 'auth' }],
    }));
    const bugId = (bug['task'] as TaskRow).id;

    // SessionStart surface: /api/board?owner=alice carries the routed bug.
    const mine = buildBoardData(b.db, 8, T0 + 2 * HOUR, { owner: 'alice/claude' });
    expect(mine.related_backlog!.map((r) => r.task_id)).toEqual([bugId]);
    expect(mine.related_backlog![0]!.match).toBe('MEDIUM');
    expect(mine.protocol_version).toBe(5);

    // An agent with no turf contact sees nothing; no owner query -> field absent.
    const other = buildBoardData(b.db, 8, T0 + 2 * HOUR, { owner: 'stranger/claude' });
    expect(other.related_backlog).toEqual([]);
    expect(buildBoardData(b.db, 8, T0 + 2 * HOUR, {}).related_backlog).toBeUndefined();

    // Heartbeat surface: alice's CURRENT task overlapping by path gets HIGH.
    const current = await b.callOk('register_task', registerArgs({
      title: 'auth hardening',
      scope: [{ path_glob: 'src/auth/session.ts' }],
    }));
    const bugWithGlob = await b.callOk('register_task', registerArgs({
      agent_id: 'qa/claude',
      title: 'session cookie not httpOnly',
      type: 'bug',
      severity: 'critical',
      start_as: 'backlog',
      scope: [{ path_glob: 'src/auth/session.ts' }],
    }));
    const beat = await b.callOk('heartbeat', {
      agent_id: 'alice/claude',
      task_id: (current['task'] as TaskRow).id,
    });
    const related = beat['related_backlog'] as RelatedBacklogBug[];
    expect(related.map((r) => r.task_id)).toContain((bugWithGlob['task'] as TaskRow).id);
    expect(related[0]!.match).toBe('HIGH'); // path contact outranks module contact
    expect(beat['related_backlog_hint']).toContain('never assigns');

    // Claimed bugs leave the routing feed (no longer unowned).
    await b.callOk('claim_task', { agent_id: 'alice/claude', task_id: bugId });
    const after = buildBoardData(b.db, 8, T0 + 3 * HOUR, { owner: 'alice/claude' });
    expect(after.related_backlog!.map((r) => r.task_id)).not.toContain(bugId);
  });

  it('does not route scopeless bugs (human web reports) or cross-project ones', async () => {
    const b = await makeTestBoard();
    await b.callOk('register_task', registerArgs({ scope: [{ module: 'auth' }] }));
    // Scopeless bug: routing needs a positive signal, UNKNOWN routes to no one.
    await b.callOk('register_task', registerArgs({
      agent_id: 'qa/claude', title: 'vague bug', type: 'bug', start_as: 'backlog', scope: [],
    }));
    // Same module name, different project: no route.
    await b.callOk('register_task', registerArgs({
      agent_id: 'qa/claude', title: 'other-repo bug', type: 'bug', start_as: 'backlog',
      project: 'other-repo', scope: [{ module: 'auth' }],
    }));
    const mine = buildBoardData(b.db, 8, T0 + HOUR, { owner: 'alice/claude' });
    expect(mine.related_backlog).toEqual([]);
  });
});
