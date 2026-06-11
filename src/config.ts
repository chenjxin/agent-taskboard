/** The ONLY place process.env is read. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** App version from package.json — works from src/ (dev) and dist/ (build), both one level under the root. */
export function appVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

export interface Config {
  port: number;
  dbPath: string;
  staleTtlHours: number;
  authToken: string | undefined;
  adminToken: string | undefined;
}

function numberFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid numeric config value: '${raw}'`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: numberFrom(env['PORT'], 8765),
    dbPath: env['DB_PATH'] ?? './data/board.db',
    staleTtlHours: numberFrom(env['STALE_TTL_HOURS'], 8),
    authToken: env['AUTH_TOKEN'] || undefined,
    adminToken: env['ADMIN_TOKEN'] || undefined,
  };
}
