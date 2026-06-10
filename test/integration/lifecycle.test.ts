import { describe, expect, it } from 'vitest';
import type { CommentRow, TaskRow } from '../../src/core/types.js';
import { HOUR, makeTestBoard, registerArgs } from './helpers.js';

async function registered(b: Awaited<ReturnType<typeof makeTestBoard>>): Promise<string> {
  const out = await b.callOk('register_task', registerArgs());
  return (out['task'] as TaskRow).id;
}

describe('add_comment', () => {
  it('posts comment and boundary_agreement; rejects overlap_notice as reserved', async () => {
    const b = await makeTestBoard();
    const id = await registered(b);
    await b.callOk('add_comment', { agent_id: 'bob/claude', task_id: id, body: 'I will take src/auth/sso only' });
    const agreed = await b.callOk('add_comment', {
      agent_id: 'bob/claude',
      task_id: id,
      body: 'AGREED: bob takes src/auth/sso/**, alice keeps the rest of src/auth/**',
      kind: 'boundary_agreement',
    });
    expect((agreed['hint'] as string)).toContain('update_scope');

    // 'overlap_notice' is excluded at the schema level (z.enum) — the SDK rejects it before the handler.
    const reserved = await b.call('add_comment', {
      agent_id: 'bob/claude',
      task_id: id,
      body: 'fake notice',
      kind: 'overlap_notice',
    });
    expect(reserved.isError).toBe(true);
    expect((reserved.content?.[0] as { text: string }).text).toMatch(/Invalid arguments/);

    const thread = await b.callOk('get_task', { agent_id: 'alice/claude', task_id: id });
    const comments = thread['comments'] as CommentRow[];
    expect(comments).toHaveLength(2);
    expect(comments.map((c) => c.kind)).toEqual(['comment', 'boundary_agreement']);
  });

  it('errors TASK_NOT_FOUND for unknown task ids', async () => {
    const b = await makeTestBoard();
    const err = await b.callErr('add_comment', { agent_id: 'a/b', task_id: 't_nope', body: 'x' });
    expect(err['error_code']).toBe('TASK_NOT_FOUND');
    expect(err['next_call_hint']).toContain('list_tasks');
  });
});

describe('update_status', () => {
  it('owner-only; requires closing_note; closes once', async () => {
    const b = await makeTestBoard();
    const id = await registered(b);

    const notOwner = await b.callErr('update_status', {
      agent_id: 'bob/claude',
      task_id: id,
      status: 'done',
      closing_note: 'x',
    });
    expect(notOwner['error_code']).toBe('NOT_TASK_OWNER');

    const noNote = await b.callErr('update_status', { agent_id: 'alice/claude', task_id: id, status: 'done' });
    expect(noNote['error_code']).toBe('VALIDATION_ERROR');
    expect(noNote['message']).toContain('closing_note');

    // 'active' is excluded at the schema level (z.enum) — there is no transition back.
    const badStatus = await b.call('update_status', {
      agent_id: 'alice/claude',
      task_id: id,
      status: 'active',
      closing_note: 'x',
    });
    expect(badStatus.isError).toBe(true);
    expect((badStatus.content?.[0] as { text: string }).text).toMatch(/Invalid arguments/);

    const closed = await b.callOk('update_status', {
      agent_id: 'alice/claude',
      task_id: id,
      status: 'done',
      closing_note: 'merged in PR #42; redis config documented in README',
    });
    expect((closed['task'] as TaskRow).status).toBe('done');
    expect((closed['task'] as TaskRow).closing_note).toContain('PR #42');

    const again = await b.callErr('update_status', {
      agent_id: 'alice/claude',
      task_id: id,
      status: 'abandoned',
      closing_note: 'x',
    });
    expect(again['error_code']).toBe('TASK_ALREADY_CLOSED');
  });
});

describe('heartbeat', () => {
  it("returns only others' comments since the previous beat and advances the cursor", async () => {
    const b = await makeTestBoard();
    const id = await registered(b);

    b.advance(HOUR);
    await b.callOk('add_comment', { agent_id: 'alice/claude', task_id: id, body: 'my own note' });
    await b.callOk('add_comment', { agent_id: 'bob/claude', task_id: id, body: 'heads up from bob' });

    b.advance(HOUR);
    const beat1 = await b.callOk('heartbeat', { agent_id: 'alice/claude', task_id: id });
    const activity1 = beat1['activity'] as CommentRow[];
    expect(activity1).toHaveLength(1); // own comment excluded
    expect(activity1[0]!.body).toBe('heads up from bob');
    expect(beat1['activity_hint']).toBeTruthy();

    const beat2 = await b.callOk('heartbeat', { agent_id: 'alice/claude', task_id: id });
    expect(beat2['activity']).toEqual([]); // cursor advanced, nothing new
    expect(beat2['activity_hint']).toBeNull();
  });

  it('is owner-only and rejects closed tasks', async () => {
    const b = await makeTestBoard();
    const id = await registered(b);
    const notOwner = await b.callErr('heartbeat', { agent_id: 'bob/claude', task_id: id });
    expect(notOwner['error_code']).toBe('NOT_TASK_OWNER');

    await b.callOk('update_status', { agent_id: 'alice/claude', task_id: id, status: 'done', closing_note: 'done' });
    const closed = await b.callErr('heartbeat', { agent_id: 'alice/claude', task_id: id });
    expect(closed['error_code']).toBe('TASK_ALREADY_CLOSED');
  });
});

describe('list_tasks', () => {
  it('defaults to active, supports owner filter, derives stale flags', async () => {
    const b = await makeTestBoard();
    const id = await registered(b);
    await b.callOk('register_task', registerArgs({ agent_id: 'bob/claude', title: 'docs pass', scope: [{ path_glob: 'docs/**' }] }));
    await b.callOk('update_status', { agent_id: 'alice/claude', task_id: id, status: 'done', closing_note: 'shipped' });

    const active = await b.callOk('list_tasks', { agent_id: 'carol/claude' });
    expect((active['tasks'] as TaskRow[]).map((t) => t.title)).toEqual(['docs pass']);

    const all = await b.callOk('list_tasks', { agent_id: 'carol/claude', status: 'all' });
    expect((all['tasks'] as TaskRow[]).length).toBe(2);

    const mine = await b.callOk('list_tasks', { agent_id: 'bob/claude', owner_agent_id: 'bob/claude' });
    const mineTasks = mine['tasks'] as Array<TaskRow & { stale: boolean }>;
    expect(mineTasks).toHaveLength(1);
    expect(mineTasks[0]!.stale).toBe(false);

    b.advance(9 * HOUR); // past the 8h TTL
    const later = await b.callOk('list_tasks', { agent_id: 'carol/claude' });
    const staleTasks = later['tasks'] as Array<TaskRow & { stale: boolean; hours_since_heartbeat: number }>;
    expect(staleTasks[0]!.stale).toBe(true);
    expect(staleTasks[0]!.hours_since_heartbeat).toBe(9);
  });

  it('get_task errors TASK_NOT_FOUND for unknown ids', async () => {
    const b = await makeTestBoard();
    const err = await b.callErr('get_task', { agent_id: 'a/b', task_id: 't_missing' });
    expect(err['error_code']).toBe('TASK_NOT_FOUND');
  });
});
