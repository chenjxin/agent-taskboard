import { describe, expect, it } from 'vitest';
import type { CommentRow, DepInfo, OverlapCounterpart, TaskRow } from '../../src/core/types.js';
import { HOUR, makeTestBoard, registerArgs, type TestBoard } from './helpers.js';

function notices(b: TestBoard, taskId: string): CommentRow[] {
  return b.db
    .prepare(`SELECT * FROM comments WHERE task_id = ? AND kind = 'overlap_notice' ORDER BY id`)
    .all(taskId) as CommentRow[];
}

describe('backlog lifecycle (start_as + claim_task)', () => {
  it('backlog item is unowned+planned, notifies nobody, and hands the claimer the full thread', async () => {
    const b = await makeTestBoard();
    // Alice is actively working on auth.
    const a = await b.callOk('register_task', registerArgs());
    const aId = (a['task'] as TaskRow).id;

    // Bob files an OVERLAPPING backlog item: report yes, notices no.
    const filed = await b.callOk('register_task', registerArgs({
      agent_id: 'bob/claude',
      title: 'sso backlog item',
      start_as: 'backlog',
      scope: [{ path_glob: 'src/auth/sso/**' }],
    }));
    const tId = (filed['task'] as TaskRow).id;
    expect((filed['task'] as TaskRow).status).toBe('planned');
    expect((filed['task'] as TaskRow).owner_agent_id).toBeNull();
    expect((filed['task'] as TaskRow).claimed_at).toBeNull();
    expect((filed['overlap_report'] as { counterparts: OverlapCounterpart[] }).counterparts[0]!.severity).toBe('HIGH');
    expect(notices(b, aId)).toHaveLength(0); // planned registration is silent
    expect(notices(b, tId)).toHaveLength(0);
    expect(filed['next_step']).toContain('claim_task');

    // Pre-claim negotiation lands on the backlog thread.
    await b.callOk('add_comment', {
      agent_id: 'alice/claude',
      task_id: tId,
      body: 'whoever takes this: keep getSession(token) signature',
    });

    // Carol claims it: owner set, active, notices fire NOW, thread delivered.
    b.advance(HOUR);
    const claimed = await b.callOk('claim_task', { agent_id: 'carol/claude', task_id: tId });
    const task = claimed['task'] as TaskRow;
    expect(task.status).toBe('active');
    expect(task.owner_agent_id).toBe('carol/claude');
    expect(task.claimed_at).toBeGreaterThan(task.created_at);
    const thread = claimed['thread'] as CommentRow[];
    expect(thread.some((c) => c.body.includes('getSession'))).toBe(true); // pre-claim comment delivered
    expect(thread.some((c) => c.body.includes('Claimed by carol/claude'))).toBe(true);
    expect((claimed['overlap_report'] as { counterparts: OverlapCounterpart[] }).counterparts[0]!.severity).toBe('HIGH');
    expect(notices(b, aId)).toHaveLength(1); // symmetric notices at claim time
    expect(notices(b, tId)).toHaveLength(1);
  });

  it('claim guards: active, closed, and other-owned planned tasks are protected', async () => {
    const b = await makeTestBoard();
    const active = await b.callOk('register_task', registerArgs());
    const activeId = (active['task'] as TaskRow).id;
    expect((await b.callErr('claim_task', { agent_id: 'bob/claude', task_id: activeId }))['error_code']).toBe(
      'TASK_ALREADY_CLAIMED',
    );

    const planned = await b.callOk('register_task', registerArgs({
      title: 'alice planned work',
      start_as: 'planned',
      scope: [{ path_glob: 'docs/**' }],
    }));
    const plannedId = (planned['task'] as TaskRow).id;
    expect((planned['task'] as TaskRow).owner_agent_id).toBe('alice/claude'); // planned keeps an owner
    const steal = await b.callErr('claim_task', { agent_id: 'bob/claude', task_id: plannedId });
    expect(steal['error_code']).toBe('NOT_TASK_OWNER');
    expect(steal['next_call_hint']).toContain('add_comment');

    // Owner can activate their own planned task.
    const activated = await b.callOk('claim_task', { agent_id: 'alice/claude', task_id: plannedId });
    expect((activated['task'] as TaskRow).status).toBe('active');

    await b.callOk('update_status', { agent_id: 'alice/claude', task_id: plannedId, status: 'done', closing_note: 'x' });
    expect((await b.callErr('claim_task', { agent_id: 'bob/claude', task_id: plannedId }))['error_code']).toBe(
      'TASK_ALREADY_CLOSED',
    );
  });

  it('planned tasks: heartbeat refused with claim hint; update_scope grooms silently', async () => {
    const b = await makeTestBoard();
    await b.callOk('register_task', registerArgs());
    const filed = await b.callOk('register_task', registerArgs({
      agent_id: 'bob/claude',
      title: 'backlog',
      start_as: 'backlog',
      scope: [{ path_glob: 'docs/**' }],
    }));
    const tId = (filed['task'] as TaskRow).id;

    const beat = await b.callErr('heartbeat', { agent_id: 'bob/claude', task_id: tId });
    expect(beat['error_code']).toBe('TASK_NOT_ACTIVE');
    expect(beat['next_call_hint']).toContain('claim_task');

    // Creator grooms the unowned item into overlapping scope — still no notices.
    const groomed = await b.callOk('update_scope', {
      agent_id: 'bob/claude',
      task_id: tId,
      scope: [{ path_glob: 'src/auth/login.ts' }],
    });
    expect((groomed['overlap_report'] as { counterparts: OverlapCounterpart[] }).counterparts[0]!.severity).toBe('HIGH');
    expect(b.db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE kind = 'overlap_notice'`).get()).toEqual({ n: 0 });
  });

  it('anyone may close an unowned backlog item; the server records who', async () => {
    const b = await makeTestBoard();
    const filed = await b.callOk('register_task', registerArgs({
      agent_id: 'bob/claude',
      title: 'stale idea',
      start_as: 'backlog',
      scope: [{ module: 'docs' }],
    }));
    const tId = (filed['task'] as TaskRow).id;
    const closed = await b.callOk('update_status', {
      agent_id: 'carol/claude',
      task_id: tId,
      status: 'abandoned',
      closing_note: 'superseded by the new docs plan',
    });
    expect((closed['task'] as TaskRow).closing_note).toBe('[closed by carol/claude] superseded by the new docs plan');
  });
});

describe('dependencies', () => {
  async function pair(b: TestBoard): Promise<[string, string]> {
    const pre = await b.callOk('register_task', registerArgs({ title: 'prerequisite', scope: [{ module: 'api' }] }));
    const dep = await b.callOk('register_task', registerArgs({
      agent_id: 'bob/claude',
      title: 'dependent work',
      scope: [{ module: 'web' }],
      depends_on: [(pre['task'] as TaskRow).id],
    }));
    return [(pre['task'] as TaskRow).id, (dep['task'] as TaskRow).id];
  }

  it('closing a prerequisite notifies dependents (RESOLVED vs ABANDONED) via heartbeat', async () => {
    const b = await makeTestBoard();
    const [preId, depId] = await pair(b);

    b.advance(HOUR);
    await b.callOk('update_status', { agent_id: 'alice/claude', task_id: preId, status: 'done', closing_note: 'merged PR 9' });
    const beat = await b.callOk('heartbeat', { agent_id: 'bob/claude', task_id: depId });
    const activity = beat['activity'] as CommentRow[];
    expect(activity).toHaveLength(1);
    expect(activity[0]!.kind).toBe('dependency_notice');
    expect(activity[0]!.body).toContain(`DEPENDENCY RESOLVED task:${preId}`);
    expect(activity[0]!.body).toContain('merged PR 9');

    // blocked flag clears once the dep is done.
    const got = await b.callOk('get_task', { agent_id: 'bob/claude', task_id: depId });
    expect(got['blocked']).toBe(false);
    expect((got['depends_on'] as DepInfo[])[0]!.status).toBe('done');
  });

  it('ABANDONED notice wording differs — an abandoned prerequisite is not resolved', async () => {
    const b = await makeTestBoard();
    const [preId, depId] = await pair(b);
    await b.callOk('update_status', { agent_id: 'alice/claude', task_id: preId, status: 'abandoned', closing_note: 'dropped' });
    const row = b.db
      .prepare(`SELECT body FROM comments WHERE task_id = ? AND kind = 'dependency_notice'`)
      .get(depId) as { body: string };
    expect(row.body).toContain(`DEPENDENCY ABANDONED task:${preId}`);
    expect(row.body).toContain('NOT completed');
  });

  it('validates missing ids, rejects cycles, warns on closed deps', async () => {
    const b = await makeTestBoard();
    const [preId, depId] = await pair(b);

    const missing = await b.callErr('register_task', registerArgs({
      agent_id: 'carol/claude',
      title: 'bad deps',
      scope: [{ module: 'x' }],
      depends_on: ['t_nonexistent'],
    }));
    expect(missing['error_code']).toBe('TASK_NOT_FOUND');
    expect(missing['message']).toContain('t_nonexistent');

    // pre -> dep edge would close the loop dep -> pre.
    const cycle = await b.callErr('update_task', { agent_id: 'alice/claude', task_id: preId, depends_on: [depId] });
    expect(cycle['error_code']).toBe('DEP_CYCLE');

    await b.callOk('update_status', { agent_id: 'alice/claude', task_id: preId, status: 'done', closing_note: 'x' });
    const closedDep = await b.callOk('update_task', { agent_id: 'bob/claude', task_id: depId, depends_on: [preId] });
    expect((closedDep['warnings'] as Record<string, unknown>)['already_closed_deps']).toContain(preId);
  });
});

describe('update_task', () => {
  it('patches metadata owner-only and requires at least one field', async () => {
    const b = await makeTestBoard();
    const reg = await b.callOk('register_task', registerArgs({ iteration: '2026w24' }));
    const id = (reg['task'] as TaskRow).id;
    expect((reg['task'] as TaskRow).iteration).toBe('2026w24');

    expect((await b.callErr('update_task', { agent_id: 'alice/claude', task_id: id }))['error_code']).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      (await b.callErr('update_task', { agent_id: 'bob/claude', task_id: id, title: 'hijack' }))['error_code'],
    ).toBe('NOT_TASK_OWNER');

    const patched = await b.callOk('update_task', {
      agent_id: 'alice/claude',
      task_id: id,
      title: 'auth session storage v2',
      iteration: '', // clears
    });
    const task = patched['task'] as TaskRow;
    expect(task.title).toBe('auth session storage v2');
    expect(task.iteration).toBeNull();
    expect(task.description).toContain('redis'); // untouched fields stay
  });
});

describe('list_tasks v2 semantics', () => {
  it("defaults to 'open' (active + planned), self-describes, filters by iteration, flags blocked", async () => {
    const b = await makeTestBoard();
    const pre = await b.callOk('register_task', registerArgs({ title: 'live work', iteration: '2026w24' }));
    await b.callOk('register_task', registerArgs({
      agent_id: 'bob/claude',
      title: 'backlog row',
      start_as: 'backlog',
      scope: [{ module: 'docs' }],
      iteration: '2026w25',
      depends_on: [(pre['task'] as TaskRow).id],
    }));

    const open = await b.callOk('list_tasks', { agent_id: 'carol/claude' });
    expect(open['applied_status_filter']).toBe('open');
    const rows = open['tasks'] as Array<TaskRow & { blocked: boolean }>;
    expect(rows.map((t) => t.status).sort()).toEqual(['active', 'planned']);
    expect(rows.find((t) => t.status === 'planned')!.blocked).toBe(true);
    expect(open['hint']).toContain('planned');

    const activeOnly = await b.callOk('list_tasks', { agent_id: 'carol/claude', status: 'active' });
    expect((activeOnly['tasks'] as TaskRow[]).map((t) => t.title)).toEqual(['live work']);

    const w25 = await b.callOk('list_tasks', { agent_id: 'carol/claude', iteration: '2026w25' });
    expect((w25['tasks'] as TaskRow[]).map((t) => t.title)).toEqual(['backlog row']);
  });

  it('check_overlap counterparts carry status and planned-specific guidance', async () => {
    const b = await makeTestBoard();
    await b.callOk('register_task', registerArgs({ start_as: 'backlog', title: 'planned auth work' }));
    const check = await b.callOk('check_overlap', {
      agent_id: 'bob/claude',
      project: 'proj',
      scope: [{ path_glob: 'src/auth/sso/**' }],
    });
    const row = (check['overlap_report'] as { counterparts: OverlapCounterpart[] }).counterparts[0]!;
    expect(row.status).toBe('planned');
    expect(row.owner_agent_id).toBeNull();
    expect(row.next_step).toContain('UNCLAIMED');
  });
});

describe('get_standup', () => {
  it('digests window activity with project/iteration filters', async () => {
    const b = await makeTestBoard();
    const pre = await b.callOk('register_task', registerArgs({ title: 'shipped thing', iteration: '2026w24' }));
    await b.callOk('register_task', registerArgs({
      agent_id: 'bob/claude',
      title: 'fresh backlog',
      start_as: 'backlog',
      scope: [{ module: 'docs' }],
      depends_on: [(pre['task'] as TaskRow).id],
    }));
    b.advance(2 * HOUR);
    await b.callOk('update_status', {
      agent_id: 'alice/claude',
      task_id: (pre['task'] as TaskRow).id,
      status: 'done',
      closing_note: 'merged',
    });

    const standup = await b.callOk('get_standup', { agent_id: 'carol/claude', project: 'proj' });
    const report = standup['standup'] as {
      projects: Array<Record<string, Array<{ task_id: string }>> & { project: string }>;
    };
    expect(report.projects).toHaveLength(1);
    const p = report.projects[0]!;
    expect(p['completed']!.map((r) => r.task_id)).toEqual([(pre['task'] as TaskRow).id]);
    expect(p['started']).toHaveLength(1); // the shipped task was claimed (registered active) in window
    expect(p['planned_added']).toHaveLength(1);
    // The backlog item's blocker closed, so nothing is blocked anymore.
    expect(p['blocked']).toHaveLength(0);

    const empty = await b.callOk('get_standup', { agent_id: 'carol/claude', project: 'nothing-here' });
    expect((empty['standup'] as { projects: unknown[] }).projects).toHaveLength(0);
    expect(empty['hint']).toContain('window_hours');
  });
});
