import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { makeTestBoard } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_DIR = join(ROOT, 'src/web');
const ADOPTION_DIR = join(ROOT, 'adoption');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

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

describe('GET /onboard', () => {
  it('serves the onboarding page with the same security headers as /board', async () => {
    const b = await makeTestBoard();
    const app = buildApp(b.deps, { webDir: WEB_DIR, adoptionDir: ADOPTION_DIR, changelogPath: CHANGELOG });
    const base = await listen(app);

    const res = await fetch(`${base}/onboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('接入');
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });
});

describe('GET /adoption/:name', () => {
  it('serves exactly the whitelisted adoption files as plain text', async () => {
    const b = await makeTestBoard();
    const app = buildApp(b.deps, { webDir: WEB_DIR, adoptionDir: ADOPTION_DIR, changelogPath: CHANGELOG });
    const base = await listen(app);

    const mcp = await fetch(`${base}/adoption/mcp-config.snippet.json`);
    expect(mcp.status).toBe(200);
    expect(mcp.headers.get('content-type')).toContain('text/plain');
    expect(await mcp.text()).toContain('task-board');

    const claudeMd = await fetch(`${base}/adoption/CLAUDE.md.snippet.md`);
    expect(claudeMd.status).toBe(200);
    expect(await claudeMd.text()).toContain('agent_id');

    const hooks = await fetch(`${base}/adoption/hooks-settings.snippet.json`);
    expect(hooks.status).toBe(200);
    expect(await hooks.text()).toContain('SessionStart');

    const sh = await fetch(`${base}/adoption/board-check.sh`);
    expect(sh.status).toBe(200);
    expect(await sh.text()).toContain('#!');
  });

  it('404s anything off the whitelist (no traversal)', async () => {
    const b = await makeTestBoard();
    const app = buildApp(b.deps, { webDir: WEB_DIR, adoptionDir: ADOPTION_DIR, changelogPath: CHANGELOG });
    const base = await listen(app);

    expect((await fetch(`${base}/adoption/evil.txt`)).status).toBe(404);
    expect((await fetch(`${base}/adoption/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/adoption/`)).status).toBe(404);
  });

  it('sits behind bearer auth when AUTH_TOKEN is set', async () => {
    const b = await makeTestBoard();
    const app = buildApp(b.deps, { webDir: WEB_DIR, adoptionDir: ADOPTION_DIR, changelogPath: CHANGELOG, authToken: 'sekret' });
    const base = await listen(app);

    expect((await fetch(`${base}/onboard`)).status).toBe(401);
    expect((await fetch(`${base}/adoption/board-check.sh`)).status).toBe(401);
    expect(
      (await fetch(`${base}/adoption/board-check.sh`, { headers: { authorization: 'Bearer sekret' } }))
        .status,
    ).toBe(200);
  });
});
