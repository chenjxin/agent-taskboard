import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { buildBoardData, type BoardPayload } from '../../src/web/boardData.js';
import type { TaskRow } from '../../src/core/types.js';
import { makeTestBoard, registerArgs, T0, HOUR } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const STATIC_OPTS = { webDir: join(ROOT, 'src/web'), adoptionDir: join(ROOT, 'adoption'), changelogPath: join(ROOT, 'CHANGELOG.md') };

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

describe('buildBoardData', () => {
  it('groups by project, defaults to active + recently closed, decorates rows', async () => {
    const b = await makeTestBoard();
    const a = await b.callOk('register_task', registerArgs());
    await b.callOk('register_task', registerArgs({ agent_id: 'bob/claude', project: 'other', title: 'other work', scope: [{ path_glob: '**' }] }));
    await b.callOk('add_comment', { agent_id: 'bob/claude', task_id: (a['task'] as TaskRow).id, body: 'hi' });

    const data = buildBoardData(b.db, 8, T0 + HOUR, {});
    expect(data.projects.map((p) => p.project)).toEqual(['other', 'proj']);
    const projTask = data.projects[1]!.tasks[0]!;
    expect(projTask.comment_count).toBe(1);
    expect(projTask.recent_comments[0]!.body).toBe('hi');
    expect(projTask.broad_glob).toBe(false);
    expect(data.projects[0]!.tasks[0]!.broad_glob).toBe(true);
    expect(projTask.stale).toBe(false);

    const owned = buildBoardData(b.db, 8, T0, { owner: 'bob/claude' });
    expect(owned.projects).toHaveLength(1);
    expect(owned.projects[0]!.tasks[0]!.owner_agent_id).toBe('bob/claude');
  });
});

describe('GET /api/board over HTTP', () => {
  it('serves the payload; XSS payloads round-trip as inert JSON text', async () => {
    const b = await makeTestBoard();
    await b.callOk('register_task', registerArgs({ title: '<script>alert(1)</script>' }));
    const app = buildApp(b.deps, STATIC_OPTS);
    const base = await listen(app);

    const res = await fetch(`${base}/api/board`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toContain('application/json');
    const payload = (await res.json()) as BoardPayload;
    expect(payload.projects[0]!.tasks[0]!.title).toBe('<script>alert(1)</script>'); // JSON-encoded text, not HTML

    const board = await fetch(`${base}/board`);
    expect(board.status).toBe(200);
    expect(board.headers.get('content-security-policy')).toContain('script-src');
    expect(board.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(board.headers.get('x-frame-options')).toBe('DENY');
    const html = await board.text();
    expect(html).toContain('Agent Task Board');
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);

    const health = await fetch(`${base}/healthz`);
    expect(await health.json()).toMatchObject({ ok: true, schema_version: 6 });

    const standup = await fetch(`${base}/api/standup?hours=48`);
    expect(standup.status).toBe(200);
    const digest = (await standup.json()) as { window_hours: number; projects: unknown[] };
    expect(digest.window_hours).toBe(48);
    expect(digest.projects.length).toBeGreaterThan(0);

    const payload2 = (await (await fetch(`${base}/api/board`)).json()) as { protocol_version: number };
    expect(payload2.protocol_version).toBe(5);
  });

  it('enforces bearer auth on /mcp and /api/board when AUTH_TOKEN is set', async () => {
    const b = await makeTestBoard();
    const app = buildApp(b.deps, { ...STATIC_OPTS, authToken: 'sekret' });
    const base = await listen(app);

    expect((await fetch(`${base}/api/board`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/board`, { headers: { authorization: 'Bearer sekret' } })).status,
    ).toBe(200);
    expect((await fetch(`${base}/board`)).status).toBe(401);
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(mcp.status).toBe(401);
    expect((await fetch(`${base}/mcp`)).status).toBe(401); // 405 handlers sit behind auth too
  });

  it('returns 405 for GET/DELETE /mcp (stateless mode)', async () => {
    const b = await makeTestBoard();
    const app = buildApp(b.deps, STATIC_OPTS);
    const base = await listen(app);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(405);
  });
});
