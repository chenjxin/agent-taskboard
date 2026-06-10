import { describe, expect, it } from 'vitest';
import { computeOverlap, moduleMatches } from '../../src/core/overlap.js';
import type { CounterpartInput, ScopeRowInput, TaskRow } from '../../src/core/types.js';

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const TTL = 8;

function mkTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    project: 'proj',
    title: `task ${id}`,
    description: `description of ${id}`,
    branch: 'main',
    owner_agent_id: 'alice/claude',
    status: 'active',
    closing_note: null,
    created_at: NOW - 2 * H,
    updated_at: NOW - 1 * H,
    closed_at: null,
    last_heartbeat_at: NOW - 1 * H,
    ...overrides,
  };
}

function counterpart(id: string, scopeRows: ScopeRowInput[], overrides: Partial<TaskRow> = {}): CounterpartInput {
  return { task: mkTask(id, overrides), scopeRows };
}

function run(myScope: ScopeRowInput[], counterparts: CounterpartInput[]) {
  return computeOverlap({
    project: 'proj',
    myScope,
    counterparts,
    didYouMean: null,
    staleTtlHours: TTL,
    now: NOW,
  });
}

describe('moduleMatches', () => {
  const TABLE: Array<[string, string, boolean]> = [
    ['auth', 'Auth', true],
    ['auth', 'auth/session', true],
    ['auth/session', 'auth', true],
    ['user-api', 'payment-api', false],
    ['auth-api', 'api', false],
    ['billing', 'bill', false],
    ['', 'auth', false],
  ];
  for (const [a, b, expected] of TABLE) {
    it(`${JSON.stringify(a)} vs ${JSON.stringify(b)} -> ${expected}`, () => {
      expect(moduleMatches(a, b)).toBe(expected);
    });
  }
});

describe('computeOverlap severity', () => {
  it('path intersection -> HIGH, even when a module also matches', () => {
    const report = run(
      [{ path_glob: 'src/auth/**', module: 'auth' }],
      [counterpart('t_a', [{ path_glob: 'src/auth/sso/**', module: 'auth' }])],
    );
    expect(report.counterparts).toHaveLength(1);
    expect(report.counterparts[0]!.severity).toBe('HIGH');
    expect(report.counterparts[0]!.matches.some((m) => m.channel === 'path')).toBe(true);
  });

  it('module-only match -> MEDIUM', () => {
    const report = run(
      [{ path_glob: 'src/web/**', module: 'auth' }],
      [counterpart('t_a', [{ path_glob: 'src/api/**', module: 'auth/session' }])],
    );
    expect(report.counterparts[0]!.severity).toBe('MEDIUM');
    expect(report.counterparts[0]!.matches.every((m) => m.channel === 'module')).toBe(true);
  });

  it('counterpart with zero scope rows -> UNKNOWN', () => {
    const report = run([{ path_glob: 'src/auth/**' }], [counterpart('t_a', [])]);
    expect(report.counterparts[0]!.severity).toBe('UNKNOWN');
  });

  it('my empty scope -> every counterpart UNKNOWN, even scoped ones', () => {
    const report = run([], [counterpart('t_a', [{ path_glob: 'src/auth/**' }]), counterpart('t_b', [])]);
    expect(report.counterparts).toHaveLength(2);
    expect(report.counterparts.every((c) => c.severity === 'UNKNOWN')).toBe(true);
  });

  it('no contact -> excluded from counterparts, counted in low_contact_count', () => {
    const report = run(
      [{ path_glob: 'src/auth/**', module: 'auth' }],
      [counterpart('t_far', [{ path_glob: 'docs/**', module: 'docs' }])],
    );
    expect(report.counterparts).toHaveLength(0);
    expect(report.low_contact_count).toBe(1);
  });

  it('max across pairs: one HIGH pair among misses -> HIGH', () => {
    const report = run(
      [{ path_glob: 'docs/**' }, { path_glob: 'src/auth/**' }],
      [counterpart('t_a', [{ path_glob: 'assets/**' }, { path_glob: 'src/auth/login.ts' }])],
    );
    expect(report.counterparts[0]!.severity).toBe('HIGH');
  });
});

describe('computeOverlap report shape', () => {
  it('stale counterpart stays in the report, flagged with timing fields', () => {
    const report = run(
      [{ path_glob: 'src/auth/**' }],
      [counterpart('t_old', [{ path_glob: 'src/auth/**' }], { last_heartbeat_at: NOW - 20 * H })],
    );
    const row = report.counterparts[0]!;
    expect(row.stale).toBe(true);
    expect(row.hours_since_heartbeat).toBe(20);
    expect(row.severity).toBe('HIGH');
  });

  it('carries the user-required counterpart context: owner, description, updated_at', () => {
    const report = run(
      [{ path_glob: 'src/auth/**' }],
      [counterpart('t_a', [{ path_glob: 'src/auth/**' }], { description: 'X'.repeat(600) })],
    );
    const row = report.counterparts[0]!;
    expect(row.owner_agent_id).toBe('alice/claude');
    expect(row.description.length).toBe(500);
    expect(row.updated_at).toBe(NOW - 1 * H);
    expect(row.next_step.length).toBeGreaterThan(0);
  });

  it('flags broad globs on both sides', () => {
    const report = run(
      [{ path_glob: '**' }],
      [counterpart('t_a', [{ path_glob: '**/*.test.ts' }])],
    );
    expect(report.broad_globs).toEqual(['**']);
    expect(report.counterparts[0]!.counterpart_broad_globs).toEqual(['**/*.test.ts']);
  });

  it('includes project, checked_scope_rows, did_you_mean and advisory text', () => {
    const report = computeOverlap({
      project: 'proj',
      myScope: [{ path_glob: 'src/**' }],
      counterparts: [],
      didYouMean: ['proj-x'],
      staleTtlHours: TTL,
      now: NOW,
    });
    expect(report.project).toBe('proj');
    expect(report.checked_scope_rows).toBe(1);
    expect(report.did_you_mean).toEqual(['proj-x']);
    expect(report.advice).toMatch(/never/i);
  });
});
