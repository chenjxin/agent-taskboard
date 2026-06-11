import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { upsertAgent } from '../../src/db/repo/agents.js';

const dir = mkdtempSync(join(tmpdir(), 'board-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('openDb on a file path', () => {
  it('initializes once, persists across reopen, and runs in WAL mode', () => {
    const path = join(dir, 'nested', 'board.db'); // exercises mkdir -p of the parent
    const db1 = openDb(path);
    expect(db1.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db1.pragma('foreign_keys', { simple: true })).toBe(1);
    upsertAgent(db1, 'alice/claude', 1000);
    db1.close();

    // Reopen: the meta table exists, so the schema apply is skipped — data survives.
    const db2 = openDb(path);
    const agent = db2.prepare(`SELECT agent_id FROM agents`).get() as { agent_id: string };
    expect(agent.agent_id).toBe('alice/claude');
    const version = db2.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(version.value).toBe('5');
    db2.close();
  });
});
