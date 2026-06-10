import { describe, expect, it } from 'vitest';
import { hoursSince, isStale } from '../../src/core/staleness.js';

const NOW = 1_800_000_000_000; // fixed reference, unix ms
const H = 3_600_000;

describe('isStale', () => {
  it('fresh heartbeat is not stale', () => {
    expect(isStale(NOW - 1 * H, 8, NOW)).toBe(false);
  });
  it('exactly at the TTL boundary is not stale (strict >)', () => {
    expect(isStale(NOW - 8 * H, 8, NOW)).toBe(false);
  });
  it('one ms past the TTL is stale', () => {
    expect(isStale(NOW - 8 * H - 1, 8, NOW)).toBe(true);
  });
  it('ancient heartbeat is stale', () => {
    expect(isStale(NOW - 100 * H, 8, NOW)).toBe(true);
  });
  it('respects the ttl parameter, not a constant', () => {
    expect(isStale(NOW - 2 * H, 1, NOW)).toBe(true);
    expect(isStale(NOW - 2 * H, 3, NOW)).toBe(false);
  });
});

describe('hoursSince', () => {
  it('returns fractional hours rounded to one decimal', () => {
    expect(hoursSince(NOW - 90 * 60_000, NOW)).toBe(1.5);
    expect(hoursSince(NOW, NOW)).toBe(0);
  });
});
