import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import type { FeedbackRow } from '../../src/db/repo/feedback.js';
import { HOUR, makeTestBoard, registerArgs } from './helpers.js';
import type { TaskRow } from '../../src/core/types.js';

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

describe('submit_feedback', () => {
  it('persists feedback; closing a task hints at the channel', async () => {
    const b = await makeTestBoard();
    const out = await b.callOk('submit_feedback', {
      agent_id: 'alice/claude',
      kind: 'friction',
      body: 'check_overlap 的 module 匹配规则我猜了两次才猜对',
      context: 'check_overlap',
    });
    expect(out['ok']).toBe(true);
    expect(out['hint']).toContain('not visible');

    const row = b.db.prepare(`SELECT * FROM feedback`).get() as FeedbackRow;
    expect(row.agent_id).toBe('alice/claude');
    expect(row.kind).toBe('friction');
    expect(row.context).toBe('check_overlap');

    // The collection moment: update_status responses carry the hint.
    const reg = await b.callOk('register_task', registerArgs());
    const closed = await b.callOk('update_status', {
      agent_id: 'alice/claude',
      task_id: (reg['task'] as TaskRow).id,
      status: 'done',
      closing_note: 'x',
    });
    expect(closed['feedback_hint']).toContain('submit_feedback');
  });

  it('rejects unknown kinds at the schema level and empty bodies', async () => {
    const b = await makeTestBoard();
    const bad = await b.call('submit_feedback', { agent_id: 'a/b', kind: 'rant', body: 'x' });
    expect(bad.isError).toBe(true);
    const empty = await b.callErr('submit_feedback', { agent_id: 'a/b', kind: 'idea', body: '   ' });
    expect(empty['error_code']).toBe('VALIDATION_ERROR');
  });
});

describe('GET /admin/feedback (non-public operator view)', () => {
  it('plays dead (404) when ADMIN_TOKEN is unset or the credential is wrong', async () => {
    const b = await makeTestBoard();
    const unset = await listen(buildApp(b.deps, OPTS));
    expect((await fetch(`${unset}/admin/feedback`)).status).toBe(404);
    expect((await fetch(`${unset}/admin/feedback?token=guess`)).status).toBe(404);

    server?.close();
    const gated = await listen(buildApp(b.deps, { ...OPTS, adminToken: 'op-secret' }));
    expect((await fetch(`${gated}/admin/feedback`)).status).toBe(404);
    expect((await fetch(`${gated}/admin/feedback?token=wrong`)).status).toBe(404);
  });

  it('returns all feedback + agent usage with the right token (header or query)', async () => {
    const b = await makeTestBoard();
    await b.callOk('submit_feedback', { agent_id: 'alice/claude', kind: 'idea', body: '想要按迭代过滤看板' });
    b.advance(HOUR);
    await b.callOk('submit_feedback', { agent_id: 'bob/claude', kind: 'praise', body: 'claim 带线程很好用' });

    const base = await listen(buildApp(b.deps, { ...OPTS, adminToken: 'op-secret' }));
    const viaQuery = await fetch(`${base}/admin/feedback?token=op-secret`);
    expect(viaQuery.status).toBe(200);
    expect(viaQuery.headers.get('cache-control')).toBe('no-store');
    const payload = (await viaQuery.json()) as {
      feedback_count: number;
      feedback: FeedbackRow[];
      agents: Array<{ agent_id: string }>;
    };
    expect(payload.feedback_count).toBe(2);
    expect(payload.feedback[0]!.kind).toBe('praise'); // newest first
    expect(payload.agents.map((a) => a.agent_id)).toContain('alice/claude');

    const viaHeader = await fetch(`${base}/admin/feedback`, {
      headers: { authorization: 'Bearer op-secret' },
    });
    expect(viaHeader.status).toBe(200);
  });

  it('is gated by ADMIN_TOKEN independently of AUTH_TOKEN', async () => {
    const b = await makeTestBoard();
    const base = await listen(buildApp(b.deps, { ...OPTS, authToken: 'lan-token', adminToken: 'op-secret' }));
    // AUTH_TOKEN alone does not open the admin view.
    expect(
      (await fetch(`${base}/admin/feedback`, { headers: { authorization: 'Bearer lan-token' } })).status,
    ).toBe(404);
    expect((await fetch(`${base}/admin/feedback?token=op-secret`)).status).toBe(200);
  });
});
