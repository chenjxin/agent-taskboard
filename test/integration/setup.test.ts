import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { makeTestBoard } from './helpers.js';

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

describe('GET /setup — agent self-serve onboarding doc', () => {
  it('serves markdown with the placeholder origin replaced by the REQUESTING host', async () => {
    const b = await makeTestBoard();
    const base = await listen(buildApp(b.deps, OPTS));

    const res = await fetch(`${base}/setup`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const md = await res.text();
    expect(md).not.toContain('__BOARD_ORIGIN__'); // placeholder fully substituted
    expect(md).toContain(`${base}/mcp`); // the address the agent actually used
    expect(md).toContain('claude mcp add');
    expect(md).toContain('agent_id');
    expect(md).toContain('mcp__task-board'); // one-shot permission rule for all tools
    expect(md).toContain('list_tasks'); // verification step
  });
});

describe('GET /changelog', () => {
  it('serves the version list as plain text', async () => {
    const b = await makeTestBoard();
    const base = await listen(buildApp(b.deps, OPTS));
    const res = await fetch(`${base}/changelog`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('1.2.0');
    expect(text).toContain('1.1.0');
    expect(text).toContain('1.0.0');
  });
});

describe('GET /healthz version info', () => {
  it('reports app version and schema version', async () => {
    const b = await makeTestBoard();
    const base = await listen(buildApp(b.deps, OPTS));
    const health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    expect(health['ok']).toBe(true);
    expect(health['version']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(health['schema_version']).toBe(5);
  });
});

describe('auth perimeter covers the new routes', () => {
  it('requires the bearer token when AUTH_TOKEN is set', async () => {
    const b = await makeTestBoard();
    const base = await listen(buildApp(b.deps, { ...OPTS, authToken: 'sekret' }));
    expect((await fetch(`${base}/setup`)).status).toBe(401);
    expect((await fetch(`${base}/changelog`)).status).toBe(401);
    expect(
      (await fetch(`${base}/setup`, { headers: { authorization: 'Bearer sekret' } })).status,
    ).toBe(200);
  });
});
