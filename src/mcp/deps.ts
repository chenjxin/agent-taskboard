import type { Db } from '../db/connection.js';

/** Dependencies injected into every tool handler. `now` is injectable for tests. */
export interface BoardDeps {
  db: Db;
  staleTtlHours: number;
  now: () => number;
}
