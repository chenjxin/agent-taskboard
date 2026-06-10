/**
 * Full-stack smoke over real HTTP with the real SDK client transport.
 * Default: boots the app on an ephemeral port. Set BOARD_URL to point at a
 * deployed instance (e.g. http://nas.lan:8765) for post-deploy verification —
 * in that mode the test uses a throwaway project slug and closes its tasks.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { openDb } from '../../src/db/connection.js';
import { buildApp } from '../../src/http/app.js';
import type { OverlapCounterpart, TaskRow, CommentRow } from '../../src/core/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const STATIC_OPTS = { webDir: join(ROOT, 'src/web'), adoptionDir: join(ROOT, 'adoption') };
const EXTERNAL = process.env['BOARD_URL'];
const PROJECT = `smoke-${process.pid}`;

let server: Server | undefined;
let base: string;

beforeAll(async () => {
  if (EXTERNAL) {
    base = EXTERNAL;
    return;
  }
  const db = openDb(':memory:');
  const app = buildApp({ db, staleTtlHours: 8, now: () => Date.now() }, STATIC_OPTS);
  base = await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
    });
  });
});
afterAll(() => server?.close());

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.isError ?? false).toBe(false);
  return res.structuredContent as Record<string, unknown>;
}

describe('end-to-end collision flow over Streamable HTTP', () => {
  it('register -> check -> collide -> negotiate -> heartbeat -> close', async () => {
    const alice = await connect('smoke-alice');
    const bob = await connect('smoke-bob');

    // listTools proves the stateless handshake; instructions arrive at init.
    const tools = await alice.listTools();
    expect(tools.tools).toHaveLength(8);

    // Alice claims auth work.
    const aReg = structured(
      (await alice.callTool({
        name: 'register_task',
        arguments: {
          agent_id: 'alice/claude',
          project: PROJECT,
          title: 'auth session storage',
          description: 'moving sessions to redis',
          scope: [{ path_glob: 'src/auth/**', module: 'auth' }],
        },
      })) as CallToolResult,
    );
    const aId = (aReg['task'] as TaskRow).id;

    // Bob receives a task touching sso: dry-run check shows Alice with full context.
    const check = structured(
      (await bob.callTool({
        name: 'check_overlap',
        arguments: { agent_id: 'bob/claude', project: PROJECT, scope: [{ path_glob: 'src/auth/sso/**' }] },
      })) as CallToolResult,
    );
    const counterpart = (check['overlap_report'] as { counterparts: OverlapCounterpart[] }).counterparts[0]!;
    expect(counterpart.severity).toBe('HIGH');
    expect(counterpart.owner_agent_id).toBe('alice/claude');
    expect(counterpart.description).toContain('redis');

    // Bob registers anyway (his human said go) and proposes a boundary on Alice's thread.
    const bReg = structured(
      (await bob.callTool({
        name: 'register_task',
        arguments: {
          agent_id: 'bob/claude',
          project: PROJECT,
          title: 'sso login flow',
          scope: [{ path_glob: 'src/auth/sso/**' }],
        },
      })) as CallToolResult,
    );
    const bId = (bReg['task'] as TaskRow).id;
    await bob.callTool({
      name: 'add_comment',
      arguments: {
        agent_id: 'bob/claude',
        task_id: aId,
        body: 'Proposal: I take src/auth/sso/** only; session interface stays as getSession(token): Session.',
        kind: 'boundary_agreement',
      },
    });

    // Alice heartbeats and receives BOTH the system overlap notice and Bob's proposal.
    const beat = structured(
      (await alice.callTool({ name: 'heartbeat', arguments: { agent_id: 'alice/claude', task_id: aId } })) as CallToolResult,
    );
    const kinds = (beat['activity'] as CommentRow[]).map((c) => c.kind).sort();
    expect(kinds).toEqual(['boundary_agreement', 'overlap_notice']);

    // Board shows the whole story.
    const board = (await (await fetch(`${base}/api/board?project=${PROJECT}`)).json()) as {
      projects: Array<{ project: string; tasks: Array<{ id: string }> }>;
    };
    const smokeProject = board.projects.find((p) => p.project === PROJECT);
    expect(smokeProject?.tasks.map((t) => t.id).sort()).toEqual([aId, bId].sort());

    // Both close with mandatory closing notes.
    for (const [client, agentId, taskId] of [
      [alice, 'alice/claude', aId],
      [bob, 'bob/claude', bId],
    ] as const) {
      const closed = structured(
        (await client.callTool({
          name: 'update_status',
          arguments: { agent_id: agentId, task_id: taskId, status: 'done', closing_note: 'smoke test complete' },
        })) as CallToolResult,
      );
      expect((closed['task'] as TaskRow).status).toBe('done');
    }

    await alice.close();
    await bob.close();
  }, 30_000);
});
