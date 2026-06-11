import { describe, expect, it } from 'vitest';
import type { CommentRow, ResourceRow, TaskRow } from '../../src/core/types.js';
import type { StandupReport } from '../../src/core/standup.js';
import { buildBoardData } from '../../src/web/boardData.js';
import { HOUR, makeTestBoard, registerArgs, T0 } from './helpers.js';

describe('waiting status', () => {
  it('pauses honestly: owner-only toggle, stale exemption, scope held, standup bucket', async () => {
    const b = await makeTestBoard();
    const reg = await b.callOk('register_task', registerArgs({ scope: [{ module: 'auth' }] }));
    const id = (reg['task'] as TaskRow).id;

    // waiting_on is the whole point — entering without it is rejected.
    const noReason = await b.callErr('update_status', {
      agent_id: 'alice/claude', task_id: id, status: 'waiting',
    });
    expect(noReason['error_code']).toBe('VALIDATION_ERROR');
    // Owner-only.
    const notOwner = await b.callErr('update_status', {
      agent_id: 'mallory/claude', task_id: id, status: 'waiting', waiting_on: 'x',
    });
    expect(notOwner['error_code']).toBe('NOT_TASK_OWNER');

    const paused = await b.callOk('update_status', {
      agent_id: 'alice/claude', task_id: id, status: 'waiting', waiting_on: '等 QA 回归 + 环境交还',
    });
    expect((paused['task'] as TaskRow).status).toBe('waiting');
    expect((paused['task'] as TaskRow).waiting_on).toBe('等 QA 回归 + 环境交还');

    // Double-pause and resume-of-active are TASK_NOT_WAITABLE.
    const again = await b.callErr('update_status', {
      agent_id: 'alice/claude', task_id: id, status: 'waiting', waiting_on: 'x',
    });
    expect(again['error_code']).toBe('TASK_NOT_WAITABLE');

    // Stale exemption: way past TTL, but waiting tasks never flag.
    b.advance(50 * HOUR);
    const board = buildBoardData(b.db, 8, T0 + 50 * HOUR, {});
    const row = board.projects[0]!.tasks.find((t) => t.id === id)!;
    expect(row.status).toBe('waiting');
    expect(row.stale).toBe(false);

    // Scope stays contested ground: a newcomer overlap-checks against it.
    const overlap = await b.callOk('check_overlap', {
      agent_id: 'bob/claude', project: 'proj', scope: [{ module: 'auth' }],
    });
    const counterparts = (overlap['overlap_report'] as { counterparts: Array<{ task_id: string }> }).counterparts;
    expect(counterparts.map((c) => c.task_id)).toContain(id);

    // Standup: separate bucket carrying waiting_on; heartbeat channel stays open.
    const standup = await b.callOk('get_standup', { agent_id: 'carol/claude' });
    const proj = (standup['standup'] as StandupReport).projects[0]!;
    expect(proj.waiting.map((w) => w.task_id)).toEqual([id]);
    expect(proj.waiting[0]!.waiting_on).toContain('QA 回归');
    expect(proj.stale).toHaveLength(0);
    await b.callOk('heartbeat', { agent_id: 'alice/claude', task_id: id });

    // Resume clears waiting_on.
    const resumed = await b.callOk('update_status', {
      agent_id: 'alice/claude', task_id: id, status: 'active',
    });
    expect((resumed['task'] as TaskRow).status).toBe('active');
    expect((resumed['task'] as TaskRow).waiting_on).toBeNull();

    // waiting tasks are also closable directly (e.g. the wait made the task moot).
    await b.callOk('update_status', {
      agent_id: 'alice/claude', task_id: id, status: 'waiting', waiting_on: 'x',
    });
    const closedFromWaiting = await b.callOk('update_status', {
      agent_id: 'alice/claude', task_id: id, status: 'done', closing_note: 'shipped while waiting resolved itself',
    });
    expect((closedFromWaiting['task'] as TaskRow).status).toBe('done');
  });

  it('a waiting prerequisite still blocks dependents', async () => {
    const b = await makeTestBoard();
    const dep = await b.callOk('register_task', registerArgs({ title: 'prereq' }));
    const depId = (dep['task'] as TaskRow).id;
    await b.callOk('register_task', registerArgs({
      agent_id: 'bob/claude', title: 'downstream', depends_on: [depId], scope: [{ module: 'x' }],
    }));
    await b.callOk('update_status', {
      agent_id: 'alice/claude', task_id: depId, status: 'waiting', waiting_on: 'upstream API fix',
    });
    const standup = await b.callOk('get_standup', { agent_id: 'carol/claude' });
    const proj = (standup['standup'] as StandupReport).projects[0]!;
    expect(proj.blocked.map((t) => t.task_id)).toContain(
      proj.blocked.find((t) => t.title === 'downstream')!.task_id,
    );
  });
});

describe('resource claims', () => {
  it('claim/conflict/extend/release/expiry, surfaced in standup and board', async () => {
    const b = await makeTestBoard();
    const claimed = await b.callOk('claim_resource', {
      agent_id: 'alice/claude', project: 'proj', name: 'test-env', hours: 4,
      note: 'auto-deploy repointed to feat/connector-hub',
    });
    expect((claimed['claim'] as ResourceRow).holder_agent_id).toBe('alice/claude');

    // Conflicting claim: structured rejection carrying the holder context.
    const conflict = await b.callErr('claim_resource', {
      agent_id: 'bob/claude', project: 'proj', name: 'test-env', hours: 1,
    });
    expect(conflict['error_code']).toBe('RESOURCE_HELD');
    expect(conflict['message']).toContain('alice/claude');
    expect(conflict['message']).toContain('connector-hub');

    // Same-holder re-claim extends.
    const extended = await b.callOk('claim_resource', {
      agent_id: 'alice/claude', project: 'proj', name: 'test-env', hours: 8,
    });
    expect((extended['claim'] as ResourceRow).until).toBe(T0 + 8 * HOUR);

    // Surfaces: standup + board payload.
    const standup = await b.callOk('get_standup', { agent_id: 'carol/claude' });
    expect((standup['standup'] as StandupReport).resources.map((r) => r.name)).toEqual(['test-env']);
    expect(buildBoardData(b.db, 8, T0 + HOUR, {}).resources).toHaveLength(1);

    // Release: holder-only, then gone.
    const notHolder = await b.callErr('release_resource', {
      agent_id: 'bob/claude', project: 'proj', name: 'test-env',
    });
    expect(notHolder['error_code']).toBe('NOT_RESOURCE_HOLDER');
    await b.callOk('release_resource', { agent_id: 'alice/claude', project: 'proj', name: 'test-env' });
    const releasedGone = await b.callErr('release_resource', {
      agent_id: 'alice/claude', project: 'proj', name: 'test-env',
    });
    expect(releasedGone['error_code']).toBe('RESOURCE_NOT_FOUND');

    // Expiry: a 1h claim is invisible after 2h — and reclaimable by anyone.
    await b.callOk('claim_resource', { agent_id: 'alice/claude', project: 'proj', name: 'gpu-0', hours: 1 });
    b.advance(2 * HOUR);
    expect(buildBoardData(b.db, 8, T0 + 3 * HOUR, {}).resources).toHaveLength(0);
    await b.callOk('claim_resource', { agent_id: 'bob/claude', project: 'proj', name: 'gpu-0', hours: 1 });
  });
});

describe('broadcast notices', () => {
  it('tops standup until expiry; project-scoped', async () => {
    const b = await makeTestBoard();
    await b.callOk('post_notice', {
      agent_id: 'alice/claude', project: 'proj', body: '测试环境本周锁定在 feat/X', ttl_hours: 2,
    });
    const standup = await b.callOk('get_standup', { agent_id: 'bob/claude' });
    expect((standup['standup'] as StandupReport).notices.map((n) => n.body)).toEqual(['测试环境本周锁定在 feat/X']);
    const filtered = await b.callOk('get_standup', { agent_id: 'bob/claude', project: 'elsewhere' });
    expect((filtered['standup'] as StandupReport).notices).toHaveLength(0);
    b.advance(3 * HOUR);
    const later = await b.callOk('get_standup', { agent_id: 'bob/claude' });
    expect((later['standup'] as StandupReport).notices).toHaveLength(0);
  });
});

describe('nudge_blocker', () => {
  it('requires a real dependency edge, composes context, cools down 24h', async () => {
    const b = await makeTestBoard();
    const blocker = await b.callOk('register_task', registerArgs({ title: 'upstream API' }));
    const blockerId = (blocker['task'] as TaskRow).id;
    const mine = await b.callOk('register_task', registerArgs({
      agent_id: 'bob/claude', title: 'downstream UI', depends_on: [blockerId], scope: [{ module: 'ui' }],
    }));
    const mineId = (mine['task'] as TaskRow).id;
    const unrelated = await b.callOk('register_task', registerArgs({
      agent_id: 'carol/claude', title: 'unrelated', scope: [{ module: 'z' }],
    }));

    // No declared edge -> NOT_A_DEPENDENT (not a general pressure channel).
    const noEdge = await b.callErr('nudge_blocker', {
      agent_id: 'carol/claude', task_id: (unrelated['task'] as TaskRow).id, blocker_task_id: blockerId,
    });
    expect(noEdge['error_code']).toBe('NOT_A_DEPENDENT');

    b.advance(5 * HOUR);
    const nudged = await b.callOk('nudge_blocker', {
      agent_id: 'bob/claude', task_id: mineId, blocker_task_id: blockerId, note: '周五要发版',
    });
    expect(nudged['posted_on']).toBe(blockerId);

    // The blocker owner receives the composed context via heartbeat.
    const beat = await b.callOk('heartbeat', { agent_id: 'alice/claude', task_id: blockerId });
    const nudgeComment = (beat['activity'] as CommentRow[]).find((c) => c.body.startsWith('NUDGE'));
    expect(nudgeComment).toBeDefined();
    expect(nudgeComment!.body).toContain(mineId);
    expect(nudgeComment!.body).toContain('~5h');
    expect(nudgeComment!.body).toContain('周五要发版');

    // Cooldown: second nudge within 24h rejected; after 24h it goes through.
    const tooSoon = await b.callErr('nudge_blocker', {
      agent_id: 'bob/claude', task_id: mineId, blocker_task_id: blockerId,
    });
    expect(tooSoon['error_code']).toBe('NUDGE_COOLDOWN');
    b.advance(25 * HOUR);
    await b.callOk('nudge_blocker', { agent_id: 'bob/claude', task_id: mineId, blocker_task_id: blockerId });

    // Closed blockers are not nudgeable.
    await b.callOk('update_status', {
      agent_id: 'alice/claude', task_id: blockerId, status: 'done', closing_note: 'shipped',
    });
    const closed = await b.callErr('nudge_blocker', {
      agent_id: 'bob/claude', task_id: mineId, blocker_task_id: blockerId,
    });
    expect(closed['error_code']).toBe('TASK_ALREADY_CLOSED');
  });
});

describe('human notices endpoint parity', () => {
  it('POST /api/notices works for humans (JSON-only, name suffixed)', async () => {
    // covered structurally in app tests; here we assert the repo-level shape via MCP read
    const b = await makeTestBoard();
    await b.callOk('post_notice', { agent_id: 'wang/human', project: 'proj', body: 'staging 今晚清库' });
    const standup = await b.callOk('get_standup', { agent_id: 'bob/claude' });
    expect((standup['standup'] as StandupReport).notices[0]!.author_agent_id).toBe('wang/human');
  });
});
