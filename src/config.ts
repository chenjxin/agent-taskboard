/** The ONLY place process.env is read. */

export interface Config {
  port: number;
  dbPath: string;
  staleTtlHours: number;
  authToken: string | undefined;
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
  };
}
