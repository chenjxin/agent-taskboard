import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { openDb, type Db } from '../../src/db/connection.js';
import type { BoardDeps } from '../../src/mcp/deps.js';
import { buildMcpServer } from '../../src/mcp/server.js';

export const T0 = 1_800_000_000_000;
export const HOUR = 3_600_000;

export interface TestBoard {
  db: Db;
  deps: BoardDeps;
  client: Client;
  /** Advance the injected clock. */
  advance: (ms: number) => void;
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  /** structuredContent of a successful call; throws on isError. */
  callOk: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** parsed {error_code,...} payload of a failed call; throws if the call succeeded. */
  callErr: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export async function makeTestBoard(staleTtlHours = 8): Promise<TestBoard> {
  let now = T0;
  const db = openDb(':memory:');
  const deps: BoardDeps = { db, staleTtlHours, now: () => now };
  const server = buildMcpServer(deps);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;

  return {
    db,
    deps,
    client,
    advance: (ms) => {
      now += ms;
    },
    call,
    callOk: async (name, args) => {
      const res = await call(name, args);
      if (res.isError) throw new Error(`expected success, got: ${JSON.stringify(res.content)}`);
      return res.structuredContent as Record<string, unknown>;
    },
    callErr: async (name, args) => {
      const res = await call(name, args);
      if (!res.isError) throw new Error(`expected error, got: ${JSON.stringify(res.structuredContent)}`);
      const first = res.content?.[0];
      if (!first || first.type !== 'text') throw new Error('error result has no text content');
      return JSON.parse(first.text) as Record<string, unknown>;
    },
  };
}

/** Minimal valid register_task args; override what the test cares about. */
export function registerArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: 'alice/claude',
    project: 'proj',
    title: 'migrate auth session storage',
    description: 'move session storage from memory to redis',
    branch: 'feat/auth-redis',
    scope: [{ path_glob: 'src/auth/**', module: 'auth' }],
    ...overrides,
  };
}
