import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

export const CURRENT_SCHEMA_VERSION = 2;
const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

function baselineSql(): string {
  return readFileSync(SCHEMA_PATH, 'utf8');
}

/**
 * Extract one CREATE statement from the baseline schema. Migrations build
 * their rebuilt tables FROM the baseline text (with the name swapped), so the
 * two paths to the current schema cannot drift apart.
 */
function baselineStatement(kind: 'table' | 'index', name: string): string {
  const re =
    kind === 'table'
      ? new RegExp(`CREATE TABLE IF NOT EXISTS ${name}\\s*\\(`)
      : new RegExp(`CREATE INDEX IF NOT EXISTS ${name}\\s`);
  const found = baselineSql()
    .split(';')
    .find((s) => re.test(s));
  if (!found) throw new Error(`baseline statement not found: ${kind} '${name}'`);
  return found.trim();
}

interface CopySpec {
  /** Explicit column list of the new table (never SELECT * — ids and order must survive). */
  target: string;
  /** Matching SELECT expressions over the old table (backfills live here). */
  source: string;
}

function rebuildFromBaseline(db: Db, table: string, copy: CopySpec): void {
  db.exec(
    baselineStatement('table', table).replace(
      `CREATE TABLE IF NOT EXISTS ${table}`,
      `CREATE TABLE ${table}_new`,
    ),
  );
  db.exec(`INSERT INTO ${table}_new (${copy.target}) SELECT ${copy.source} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
}

interface Migration {
  to: number;
  name: string;
  up: (db: Db) => void;
}

const MIGRATIONS: Migration[] = [
  {
    to: 2,
    name: 'agile: planned/backlog lifecycle, iterations, dependencies',
    up: (db) => {
      rebuildFromBaseline(db, 'tasks', {
        target:
          'id, project, title, description, branch, owner_agent_id, created_by_agent_id, status, iteration, closing_note, created_at, updated_at, claimed_at, closed_at, last_heartbeat_at',
        // Backfills: creator = owner (v1 had no separate creator), claimed_at =
        // created_at (v1 semantics: registering WAS claiming), iteration = NULL.
        source:
          'id, project, title, description, branch, owner_agent_id, owner_agent_id, status, NULL, closing_note, created_at, updated_at, created_at, closed_at, last_heartbeat_at',
      });
      rebuildFromBaseline(db, 'comments', {
        target: 'id, task_id, author_agent_id, kind, body, created_at',
        source: 'id, task_id, author_agent_id, kind, body, created_at',
      });
      db.exec(baselineStatement('table', 'task_deps'));
      for (const idx of [
        'idx_tasks_project_status',
        'idx_tasks_owner_status',
        'idx_comments_task_created',
        'idx_task_deps_reverse',
      ]) {
        db.exec(baselineStatement('index', idx));
      }
    },
  },
];

function hasMetaTable(db: Db): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get() !==
    undefined
  );
}

export function schemaVersion(db: Db): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!row) throw new Error('meta.schema_version missing');
  return Number(row.value);
}

function runMigration(db: Db, m: Migration): void {
  // The foreign_keys pragma is a NO-OP inside a transaction (SQLite rule), and
  // openDb enables it — toggle OUTSIDE the transaction or DROP TABLE cascades.
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      interface FkViolation {
        table: string;
        rowid: number;
        parent: string;
        fkid: number;
      }
      const violations = db.pragma('foreign_key_check') as FkViolation[];
      if (violations.length > 0) {
        throw new Error(`foreign_key_check found violations: ${JSON.stringify(violations.slice(0, 3))}`);
      }
      db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(m.to));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(
        `migration '${m.name}' (to v${m.to}) failed and was rolled back: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Open (and if needed initialize or migrate) the board database.
 * Pass ':memory:' for tests. For file paths the containing directory is
 * created — WAL needs board.db, -wal and -shm to live together in it.
 * Throws on migration failure (the transaction is rolled back); the caller
 * should exit rather than retry in a loop.
 */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // better-sqlite3 does NOT enable foreign keys by default.
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!hasMetaTable(db)) {
    db.exec(baselineSql());
    return db;
  }
  let version = schemaVersion(db);
  for (const m of MIGRATIONS) {
    if (m.to <= version) continue;
    runMigration(db, m);
    version = m.to;
  }
  return db;
}
