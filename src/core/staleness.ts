/**
 * Read-time derived staleness. Never stored, never auto-transitioned:
 * the board flags, humans decide. stale != dead — a human+agent session
 * legitimately pauses for hours.
 */

const MS_PER_HOUR = 3_600_000;

/** Strictly past the TTL (a heartbeat exactly at the boundary is not stale). */
export function isStale(lastHeartbeatAt: number, ttlHours: number, now: number): boolean {
  return now - lastHeartbeatAt > ttlHours * MS_PER_HOUR;
}

/** Fractional hours since `ts`, rounded to one decimal. */
export function hoursSince(ts: number, now: number): number {
  return Math.round(((now - ts) / MS_PER_HOUR) * 10) / 10;
}
