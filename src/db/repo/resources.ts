/**
 * Exclusive shared-resource claims (test env, GPU pool, staging, shared DB).
 * A row is a DECLARATION of a current hold — never an enforced lock; the board
 * records and surfaces, the holder's word is the mechanism. until is mandatory
 * (claims always expire); expired rows are invisible to reads and lazily
 * deleted before writes.
 */
import type { NoticeRow, ResourceRow } from '../../core/types.js';
import type { Db } from '../connection.js';

function evictExpired(db: Db, now: number): void {
  db.prepare(`DELETE FROM resources WHERE until <= ?`).run(now);
}

export function liveClaims(db: Db, now: number, project?: string): ResourceRow[] {
  return db
    .prepare(
      `SELECT * FROM resources WHERE until > ? ${project ? 'AND project = ?' : ''} ORDER BY project, name`,
    )
    .all(...(project ? [now, project] : [now])) as ResourceRow[];
}

export function liveClaim(db: Db, project: string, name: string, now: number): ResourceRow | undefined {
  return db
    .prepare(`SELECT * FROM resources WHERE project = ? AND name = ? AND until > ?`)
    .get(project, name, now) as ResourceRow | undefined;
}

/**
 * Claim or extend. Returns the resulting row; throws nothing — the CALLER
 * checks for a conflicting holder first (inside the same transaction).
 * Same-holder re-claim = extension (until/note replaced, claimed_at kept).
 */
export function upsertClaim(
  db: Db,
  project: string,
  name: string,
  holder: string,
  until: number,
  note: string | null,
  now: number,
): ResourceRow {
  evictExpired(db, now);
  db.prepare(
    `INSERT INTO resources (project, name, holder_agent_id, note, claimed_at, until)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, name) DO UPDATE SET
       holder_agent_id = excluded.holder_agent_id,
       note = excluded.note,
       until = excluded.until`,
  ).run(project, name, holder, note, now, until);
  return liveClaim(db, project, name, now) as ResourceRow;
}

export function deleteClaim(db: Db, project: string, name: string): void {
  db.prepare(`DELETE FROM resources WHERE project = ? AND name = ?`).run(project, name);
}

// --- notices (same coordination family, kept in one repo file) ---------------

export function insertNotice(
  db: Db,
  project: string,
  author: string,
  body: string,
  now: number,
  expiresAt: number,
): NoticeRow {
  db.prepare(`DELETE FROM notices WHERE expires_at <= ?`).run(now);
  const info = db
    .prepare(
      `INSERT INTO notices (project, author_agent_id, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(project, author, body, now, expiresAt);
  return db.prepare(`SELECT * FROM notices WHERE id = ?`).get(info.lastInsertRowid) as NoticeRow;
}

export function liveNotices(db: Db, now: number, project?: string): NoticeRow[] {
  return db
    .prepare(
      `SELECT * FROM notices WHERE expires_at > ? ${project ? 'AND project = ?' : ''} ORDER BY created_at DESC LIMIT 50`,
    )
    .all(...(project ? [now, project] : [now])) as NoticeRow[];
}
