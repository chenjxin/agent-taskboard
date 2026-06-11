import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import type { CommentRow, TaskRow } from '../../src/core/types.js';
import { HOUR, makeTestBoard, registerArgs, type TestBoard } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OPTS = {
  webDir: join(ROOT, 'src/web'),
  adoptionDir: join(ROOT, 'adoption'),
  changelogPath: join(ROOT, 'CHANGELOG.md'),
};

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function listen(app: ReturnType<typeof buildApp>): Promise<string> {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
    });
  });
}

function bugArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return registerArgs({
    title: 'login 500s on empty password',
    type: 'bug',
    severity: 'high',
    start_as: 'backlog',
    description: '步骤:空密码提交 → 期望 400 → 实际 500',
    ...overrides,
  });
}

async function claimedBug(b: TestBoard, fixer = 'bob/claude'): Promise<string> {
  const filed = await b.callOk('register_task', bugArgs());
  const id = (filed['task'] as TaskRow).id;
  await b.callOk('claim_task', { agent_id: fixer, task_id: id });
  return id;
}

describe('bug lifecycle over MCP', () => {
  it('report -> claim -> fix_ready -> verify_fail (heartbeat delivers) -> fix_ready -> verify_pass', async () => {
    const b = await makeTestBoard();
    const filed = await b.callOk('register_task', bugArgs());
    const id = (filed['task'] as TaskRow).id;
    expect((filed['task'] as TaskRow).type).toBe('bug');
    expect((filed['task'] as TaskRow).severity).toBe('high');

    await b.callOk('claim_task', { agent_id: 'bob/claude', task_id: id });
    b.advance(HOUR);
    const fixedOut = await b.callOk('update_bug_state', {
      agent_id: 'bob/claude',
      task_id: id,
      event: 'fix_ready',
      note: '改了 validator;验证:空密码提交应返回 400',
    });
    const fixedTask = fixedOut['task'] as TaskRow;
    expect(fixedTask.status).toBe('fixed');
    expect(fixedTask.fixed_at).toBeGreaterThan(0);
    expect(fixedTask.closed_at).toBeNull(); // fixed NEVER doubles as closed
    expect(fixedOut['next_step']).toContain('KEEP');

    // Reporter rejects; the fixer hears about it via heartbeat on the FIXED task.
    b.advance(HOUR);
    await b.callOk('update_bug_state', {
      agent_id: 'alice/claude',
      task_id: id,
      event: 'verify_fail',
      note: '仍然 500,缺少 null check',
    });
    const reopened = await b.callOk('get_task', { agent_id: 'alice/claude', task_id: id });
    expect((reopened['task'] as TaskRow).status).toBe('active');
    expect((reopened['task'] as TaskRow).owner_agent_id).toBe('bob/claude'); // owner unchanged
    expect((reopened['task'] as TaskRow).fixed_at).toBeNull();

    b.advance(HOUR);
    const beat = await b.callOk('heartbeat', { agent_id: 'bob/claude', task_id: id });
    const bodies = (beat['activity'] as CommentRow[]).map((c) => c.body).join('\n');
    expect(bodies).toContain('FIX REJECTED');
    expect(bodies).toContain('null check');

    await b.callOk('update_bug_state', { agent_id: 'bob/claude', task_id: id, event: 'fix_ready', note: '补了 null check' });
    const passed = await b.callOk('update_bug_state', {
      agent_id: 'alice/claude',
      task_id: id,
      event: 'verify_pass',
      note: '空密码返回 400,回归通过',
    });
    const done = passed['task'] as TaskRow;
    expect(done.status).toBe('done');
    expect(done.closing_note).toContain('[verified by alice/claude via mcp]');
  });

  it('guards every illegal transition with a typed error', async () => {
    const b = await makeTestBoard();
    // dev task -> NOT_A_BUG
    const dev = await b.callOk('register_task', registerArgs());
    const devId = (dev['task'] as TaskRow).id;
    expect(
      (await b.callErr('update_bug_state', { agent_id: 'alice/claude', task_id: devId, event: 'fix_ready', note: 'x' }))['error_code'],
    ).toBe('NOT_A_BUG');

    // planned bug -> BUG_NOT_ACTIVE; verify on planned -> BUG_NOT_FIXED
    const filed = await b.callOk('register_task', bugArgs());
    const bugId = (filed['task'] as TaskRow).id;
    expect(
      (await b.callErr('update_bug_state', { agent_id: 'alice/claude', task_id: bugId, event: 'fix_ready', note: 'x' }))['error_code'],
    ).toBe('BUG_NOT_ACTIVE');
    expect(
      (await b.callErr('update_bug_state', { agent_id: 'alice/claude', task_id: bugId, event: 'verify_pass', note: 'x' }))['error_code'],
    ).toBe('BUG_NOT_FIXED');

    // active bug: verify before fix_ready -> BUG_NOT_FIXED; fix_ready by non-owner -> NOT_TASK_OWNER
    await b.callOk('claim_task', { agent_id: 'bob/claude', task_id: bugId });
    expect(
      (await b.callErr('update_bug_state', { agent_id: 'alice/claude', task_id: bugId, event: 'verify_pass', note: 'x' }))['error_code'],
    ).toBe('BUG_NOT_FIXED');
    expect(
      (await b.callErr('update_bug_state', { agent_id: 'carol/claude', task_id: bugId, event: 'fix_ready', note: 'x' }))['error_code'],
    ).toBe('NOT_TASK_OWNER');

    // fixed: fix_ready again -> BUG_NOT_ACTIVE; claim -> TASK_ALREADY_CLAIMED with verify hint
    await b.callOk('update_bug_state', { agent_id: 'bob/claude', task_id: bugId, event: 'fix_ready', note: 'done' });
    expect(
      (await b.callErr('update_bug_state', { agent_id: 'bob/claude', task_id: bugId, event: 'fix_ready', note: 'x' }))['error_code'],
    ).toBe('BUG_NOT_ACTIVE');
    const claimErr = await b.callErr('claim_task', { agent_id: 'carol/claude', task_id: bugId });
    expect(claimErr['error_code']).toBe('TASK_ALREADY_CLAIMED');
    expect(claimErr['next_call_hint']).toContain('update_bug_state');

    // closed: any event -> TASK_ALREADY_CLOSED
    await b.callOk('update_bug_state', { agent_id: 'alice/claude', task_id: bugId, event: 'verify_pass', note: 'ok' });
    expect(
      (await b.callErr('update_bug_state', { agent_id: 'alice/claude', task_id: bugId, event: 'verify_fail', note: 'x' }))['error_code'],
    ).toBe('TASK_ALREADY_CLOSED');
  });

  it('self-verification warns; direct update_status(done) on a bug warns about skipped verification', async () => {
    const b = await makeTestBoard();
    const id = await claimedBug(b);
    await b.callOk('update_bug_state', { agent_id: 'bob/claude', task_id: id, event: 'fix_ready', note: 'x' });
    const selfVerified = await b.callOk('update_bug_state', {
      agent_id: 'bob/claude',
      task_id: id,
      event: 'verify_pass',
      note: '自测通过',
    });
    expect((selfVerified['warnings'] as Record<string, unknown>)['self_verification']).toContain('same identity');

    const id2 = await claimedBug(b);
    const closed = await b.callOk('update_status', {
      agent_id: 'bob/claude',
      task_id: id2,
      status: 'done',
      closing_note: 'fixed directly',
    });
    expect((closed['warnings'] as Record<string, unknown>)['verification_skipped']).toContain('audit');
  });

  it('fixed bugs stay editable (severity triage / scope grooming) and block dependents until verified', async () => {
    const b = await makeTestBoard();
    const id = await claimedBug(b);
    const dep = await b.callOk('register_task', registerArgs({
      agent_id: 'carol/claude',
      title: 'gated by the bugfix',
      scope: [{ module: 'web' }],
      depends_on: [id],
    }));
    const depId = (dep['task'] as TaskRow).id;
    await b.callOk('update_bug_state', { agent_id: 'bob/claude', task_id: id, event: 'fix_ready', note: 'x' });

    // Deliberate: metadata/scope edits remain allowed while fixed (the fix_ready
    // note lives in an immutable system comment — the audit trail is safe).
    const patched = await b.callOk('update_task', { agent_id: 'bob/claude', task_id: id, severity: 'low' });
    expect((patched['task'] as TaskRow).severity).toBe('low');
    await b.callOk('update_scope', { agent_id: 'bob/claude', task_id: id, scope: [{ module: 'auth' }] });

    // Unverified fix still blocks dependents — it unblocks at verify_pass.
    const before = await b.callOk('get_task', { agent_id: 'carol/claude', task_id: depId });
    expect(before['blocked']).toBe(true);
    await b.callOk('update_bug_state', { agent_id: 'alice/claude', task_id: id, event: 'verify_pass', note: 'ok' });
    const after = await b.callOk('get_task', { agent_id: 'carol/claude', task_id: depId });
    expect(after['blocked']).toBe(false);
  });

  it('verify_pass notifies dependents; standup buckets fixed bugs as awaiting_verification', async () => {
    const b = await makeTestBoard();
    const id = await claimedBug(b);
    await b.callOk('register_task', registerArgs({
      agent_id: 'carol/claude',
      title: 'depends on the bugfix',
      scope: [{ module: 'web' }],
      depends_on: [id],
    }));
    await b.callOk('update_bug_state', { agent_id: 'bob/claude', task_id: id, event: 'fix_ready', note: 'x' });

    const standup = await b.callOk('get_standup', { agent_id: 'carol/claude', project: 'proj' });
    const proj = (standup['standup'] as { projects: Array<Record<string, unknown>> }).projects[0]!;
    const awaiting = proj['awaiting_verification'] as Array<{ task_id: string; severity: string }>;
    expect(awaiting.map((r) => r.task_id)).toEqual([id]);
    expect(awaiting[0]!.severity).toBe('high');
    // fixed is NOT completed/abandoned (closed_at untouched).
    expect(proj['completed']).toEqual([]);
    expect(proj['abandoned']).toEqual([]);

    const passed = await b.callOk('update_bug_state', { agent_id: 'alice/claude', task_id: id, event: 'verify_pass', note: 'ok' });
    expect((passed['dependents_notified'] as string[]).length).toBe(1);
  });
});

describe('human web channel (/report-bug + /api/bugs)', () => {
  it('web-reported bugs go through the same core: backlog, /human identity, overlap-visible', async () => {
    const b = await makeTestBoard();
    await b.callOk('register_task', registerArgs()); // alice active on src/auth/**
    const base = await listen(buildApp(b.deps, OPTS));

    const page = await fetch(`${base}/report-bug`);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);

    const res = await fetch(`${base}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'wang',
        project: 'proj',
        title: 'auth page crashes',
        severity: 'critical',
        description: '打开 /auth 即白屏',
      }),
    });
    expect(res.status).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };

    const got = await b.callOk('get_task', { agent_id: 'alice/claude', task_id });
    const task = got['task'] as TaskRow;
    expect(task.created_by_agent_id).toBe('wang/human'); // server-appended suffix
    expect(task.owner_agent_id).toBeNull();
    expect(task.status).toBe('planned');
    expect(task.type).toBe('bug');

    // Parity: the web-filed bug behaves exactly like an MCP one — claim works.
    await b.callOk('claim_task', { agent_id: 'bob/claude', task_id });
    await b.callOk('update_bug_state', { agent_id: 'bob/claude', task_id, event: 'fix_ready', note: 'x' });

    // Human verify via the board buttons' endpoint: fail then pass.
    const fail = await fetch(`${base}/api/bugs/${task_id}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wang', passed: false, note: '还是白屏' }),
    });
    expect(fail.status).toBe(200);
    expect(((await fail.json()) as { status: string }).status).toBe('active');

    await b.callOk('update_bug_state', { agent_id: 'bob/claude', task_id, event: 'fix_ready', note: 'y' });
    const pass = await fetch(`${base}/api/bugs/${task_id}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wang', passed: true, note: '白屏修复,回归通过' }),
    });
    expect(pass.status).toBe(200);
    const final = await b.callOk('get_task', { agent_id: 'alice/claude', task_id });
    expect((final['task'] as TaskRow).status).toBe('done');
    expect((final['task'] as TaskRow).closing_note).toContain('[verified by wang/human via web]');
  });

  it('enforces the write-path invariants: JSON-only 415, name shape, 404 unknown bug, rate limit', async () => {
    const b = await makeTestBoard();
    const base = await listen(buildApp(b.deps, OPTS));

    const textPost = await fetch(`${base}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'name=wang',
    });
    expect(textPost.status).toBe(415); // CSRF stance: non-JSON never reaches a handler

    const badName = await fetch(`${base}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wang/claude', project: 'p', title: 't', description: 'd' }),
    });
    expect(badName.status).toBe(400); // slash rejected — the form cannot impersonate an agent_id

    const missing = await fetch(`${base}/api/bugs/t_nope/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wang', passed: true, note: 'x' }),
    });
    expect(missing.status).toBe(404);

    let limited = 0;
    for (let i = 0; i < 35; i++) {
      const r = await fetch(`${base}/api/bugs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'spam', project: 'p', title: `t${i}`, description: 'd' }),
      });
      if (r.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0); // token bucket bites within a burst
  });
});
