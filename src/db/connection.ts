import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

function hasMetaTable(db: Db): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
    .get();
  return row !== undefined;
}

/**
 * Open (and if needed initialize) the board database.
 * Pass ':memory:' for tests. For file paths the containing directory is
 * created — WAL needs board.db, -wal and -shm to live together in it.
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
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  }
  return db;
}
