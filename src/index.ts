import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db/connection.js';
import { buildApp } from './http/app.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const deps = { db, staleTtlHours: config.staleTtlHours, now: () => Date.now() };

// Works in dev (tsx on src/) and in the build (assets copied into dist/).
const base = dirname(fileURLToPath(import.meta.url));
const webDir = join(base, 'web');
// dist/adoption in the build; repo-root adoption/ when running from src/.
const adoptionDir = existsSync(join(base, 'adoption')) ? join(base, 'adoption') : join(base, '..', 'adoption');

const app = buildApp(deps, { authToken: config.authToken, webDir, adoptionDir });
const server = app.listen(config.port, () => {
  console.log(
    `[${new Date().toISOString()}] task-board listening on :${config.port} ` +
      `(db=${config.dbPath}, stale_ttl=${config.staleTtlHours}h, auth=${config.authToken ? 'bearer' : 'open-lan'})`,
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
