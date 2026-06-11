import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import type { TaskRow } from '../../src/core/types.js';
import { buildBoardData } from '../../src/web/boardData.js';
import { HOUR, makeTestBoard, registerArgs, T0 } from './helpers.js';

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

describe('human-friendly report form (dropdowns + structured fields)', () => {
  it('serves the board vocabulary and registers a structured, ROUTABLE bug', async () => {
    const b = await makeTestBoard();
    // alice's task declares the vocabulary the form will offer.
    await b.callOk('register_task', registerArgs({
      scope: [{ path_glob: 'src/auth/**', module: 'auth' }, { module: 'export' }],
    }));
    const base = await listen(buildApp(b.deps, OPTS));

    // Dropdown metadata: projects + their declared modules, deduped and sorted.
    const meta = (await (await fetch(`${base}/api/report-meta`)).json()) as {
      projects: Array<{ project: string; modules: string[] }>;
    };
    expect(meta.projects).toEqual([{ project: 'proj', modules: ['auth', 'export'] }]);

    // Structured submission: module picked + steps/expected/actual split.
    const res = await fetch(`${base}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'laoli',
        project: 'proj',
        module: 'auth',
        title: '登录后回跳丢失',
        severity: 'high',
        description: '1. 登录\n2. 跳回首页',
        expected: '回到登录前页面',
        actual: '落在首页',
      }),
    });
    expect(res.status).toBe(201);
    const { task_id } = (await res.json()) as { task_id: string };

    // Description carries the three labeled sections.
    const got = await b.callOk('get_task', { agent_id: 'alice/claude', task_id });
    const task = got['task'] as TaskRow;
    expect(task.description).toContain('复现步骤:');
    expect(task.description).toContain('期望表现:\n回到登录前页面');
    expect(task.description).toContain('实际表现:\n落在首页');

    // The picked module became a scope row -> the bug ROUTES to alice's turf.
    const mine = buildBoardData(b.db, 8, T0 + HOUR, { owner: 'alice/claude' });
    expect(mine.related_backlog!.map((r) => r.task_id)).toContain(task_id);

    // Optional fields stay optional: steps-only submission still lands.
    const minimal = await fetch(`${base}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'laoli', project: 'proj', title: '只有步骤', description: '步骤而已',
      }),
    });
    expect(minimal.status).toBe(201);
  });
});
