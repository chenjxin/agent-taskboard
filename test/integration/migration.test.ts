import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/connection.js';

const dir = mkdtempSync(join(tmpdir(), 'board-migrate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The exact v1 schema as shipped (commit 352abe6). */
const V1_SCHEMA = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('schema_version', '1');
CREATE TABLE agents (
  agent_id      TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  project           TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  branch            TEXT,
  owner_agent_id    TEXT NOT NULL REFERENCES agents(agent_id),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'abandoned')),
  closing_note      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER,
  last_heartbeat_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_project_status ON tasks(project, status);
CREATE INDEX idx_tasks_owner_status ON tasks(owner_agent_id, status);
CREATE TABLE scopes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path_glob TEXT,
  module    TEXT,
  note      TEXT,
  CHECK (path_glob IS NOT NULL OR module IS NOT NULL)
);
CREATE INDEX idx_scopes_task ON scopes(task_id);
CREATE TABLE comments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_agent_id TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('comment', 'boundary_agreement', 'overlap_notice')),
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_comments_task_created ON comments(task_id, created_at);
`;

function seedV1(path: string): void {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(V1_SCHEMA);
  db.exec(`
    INSERT INTO agents VALUES ('alice/claude', 100, 200), ('bob/claude', 150, 250);
    INSERT INTO tasks VALUES
      ('t_aaa', 'proj', 'auth work', 'desc a', 'main', 'alice/claude', 'active', NULL, 1000, 2000, NULL, 2000),
      ('t_bbb', 'proj', 'old work', 'desc b', NULL, 'bob/claude', 'done', 'merged in PR 1', 500, 900, 900, 800);
    INSERT INTO scopes (task_id, path_glob, module, note) VALUES
      ('t_aaa', 'src/auth/**', 'auth', NULL),
      ('t_bbb', NULL, 'docs', 'notes');
    INSERT INTO comments (id, task_id, author_agent_id, kind, body, created_at) VALUES
      (1, 't_aaa', 'system', 'overlap_notice', 'OVERLAP HIGH task:t_bbb' || char(10) || 'details', 1500),
      (2, 't_aaa', 'bob/claude', 'comment', 'hello', 1600),
      (3, 't_aaa', 'bob/claude', 'boundary_agreement', 'split agreed', 1700);
  `);
  db.close();
}

/** Normalized (type, name, sql) triples for schema-equality comparison. */
function schemaShape(db: Database.Database): Array<[string, string, string]> {
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
  return rows.map((r) => [
    r.type,
    r.name,
    r.sql
      .replace(/["'\s]+/g, ' ')
      .replace(/IF NOT EXISTS /gi, '') // sqlite may or may not retain it in sqlite_master
      .trim()
      .toLowerCase(),
  ]);
}

describe('v1 -> v2 migration', () => {
  it('migrates a populated v1 db preserving rows, ids and order; fk_check clean; idempotent', () => {
    const path = join(dir, 'v1-data.db');
    seedV1(path);

    const db = openDb(path); // runs the migration
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({
      value: '6',
    });

    // Rows preserved, new columns backfilled.
    const tA = db.prepare(`SELECT * FROM tasks WHERE id = 't_aaa'`).get() as Record<string, unknown>;
    expect(tA['owner_agent_id']).toBe('alice/claude');
    expect(tA['created_by_agent_id']).toBe('alice/claude'); // backfill = owner
    expect(tA['claimed_at']).toBe(1000); // backfill = created_at (v1: register == claim)
    expect(tA['iteration']).toBeNull();
    expect(tA['status']).toBe('active');
    expect(tA['type']).toBe('dev'); // v4 backfill
    expect(tA['severity']).toBeNull();
    expect(tA['fixed_at']).toBeNull();

    // Comment AUTOINCREMENT ids preserved (thread ordering keys).
    const ids = db.prepare(`SELECT id FROM comments ORDER BY created_at, id`).all() as Array<{ id: number }>;
    expect(ids.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM scopes`).get()).toEqual({ n: 2 });

    // New shape works: planned + unowned + deps + dependency_notice kind.
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.prepare(
      `INSERT INTO tasks (id, project, title, owner_agent_id, created_by_agent_id, status, created_at, updated_at, last_heartbeat_at)
       VALUES ('t_ccc', 'proj', 'backlog item', NULL, 'alice/claude', 'planned', 3000, 3000, 3000)`,
    ).run();
    db.prepare(`INSERT INTO task_deps (task_id, depends_on_task_id, created_at) VALUES ('t_ccc', 't_aaa', 3000)`).run();
    db.prepare(
      `INSERT INTO comments (task_id, author_agent_id, kind, body, created_at)
       VALUES ('t_ccc', 'system', 'dependency_notice', 'DEPENDENCY RESOLVED task:t_aaa', 3100)`,
    ).run();
    // a dev-type task can never be 'fixed' (bug-only lifecycle CHECK).
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, project, title, owner_agent_id, created_by_agent_id, status, type, created_at, updated_at, last_heartbeat_at)
           VALUES ('t_eee', 'proj', 'bad fixed', 'alice/claude', 'alice/claude', 'fixed', 'dev', 1, 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    // active without owner violates the new invariant CHECK.
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, project, title, owner_agent_id, created_by_agent_id, status, created_at, updated_at, last_heartbeat_at)
           VALUES ('t_ddd', 'proj', 'bad', NULL, 'alice/claude', 'active', 1, 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    db.close();

    // Idempotent: reopening does not re-run anything or lose data.
    const again = openDb(path);
    expect(again.prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 3 });
    again.close();
  });

  it('migrated schema is identical to the fresh v2 baseline', () => {
    const path = join(dir, 'v1-empty.db');
    seedV1(path);
    const migrated = openDb(path);
    const fresh = openDb(':memory:');
    expect(schemaShape(migrated)).toEqual(schemaShape(fresh));
    migrated.close();
    fresh.close();
  });

  it('rolls back atomically on mid-migration failure and succeeds on retry', () => {
    const path = join(dir, 'v1-fail.db');
    seedV1(path);
    // Sabotage: a table whose name the migration needs triggers a clean throw.
    const pre = new Database(path);
    pre.exec(`CREATE TABLE tasks_new (x INTEGER)`);
    pre.close();

    expect(() => openDb(path)).toThrow();
    const check = new Database(path);
    expect(check.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({
      value: '1',
    }); // rollback left v1 intact
    expect(check.prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 2 });
    check.exec(`DROP TABLE tasks_new`);
    check.close();

    const db = openDb(path); // retry succeeds
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({
      value: '6',
    });
    db.close();
  });
});
