import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb, schemaVersion, type Db } from './db/connection.js';
import { buildApp } from './http/app.js';

const config = loadConfig();

function openOrExit(path: string): Db {
  try {
    return openDb(path);
  } catch (e) {
    // Migration failures roll back; exit loudly instead of letting
    // `restart: unless-stopped` retry the same failure invisibly forever.
    console.error(
      `[${new Date().toISOString()}] FATAL: database open/migration failed:`,
      e instanceof Error ? e.message : e,
    );
    process.exit(1);
  }
}

const db = openOrExit(config.dbPath);
const deps = { db, staleTtlHours: config.staleTtlHours, now: () => Date.now() };

// Works in dev (tsx on src/) and in the build (assets copied into dist/).
const base = dirname(fileURLToPath(import.meta.url));
const webDir = join(base, 'web');
// dist/adoption + dist/CHANGELOG.md in the build; repo root when running from src/.
const adoptionDir = existsSync(join(base, 'adoption')) ? join(base, 'adoption') : join(base, '..', 'adoption');
const changelogPath = existsSync(join(base, 'CHANGELOG.md'))
  ? join(base, 'CHANGELOG.md')
  : join(base, '..', 'CHANGELOG.md');

const app = buildApp(deps, { authToken: config.authToken, webDir, adoptionDir, changelogPath });
const server = app.listen(config.port, () => {
  console.log(
    `[${new Date().toISOString()}] task-board listening on :${config.port} ` +
      `(db=${config.dbPath}, schema=v${schemaVersion(db)}, stale_ttl=${config.staleTtlHours}h, auth=${config.authToken ? 'bearer' : 'open-lan'})`,
  );
});

function shutdown(signal: string): void {
  console.log(`[${new Date().toISOString()}] ${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
