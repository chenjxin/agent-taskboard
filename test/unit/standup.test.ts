import { describe, expect, it } from 'vitest';
import { blockingDeps, computeStandup } from '../../src/core/standup.js';
import type { DepInfo, TaskRow } from '../../src/core/types.js';

const NOW = 1_800_000_000_000;
const H = 3_600_000;

function task(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    project: 'proj',
    title: `task ${id}`,
    description: '',
    branch: null,
    owner_agent_id: 'alice/claude',
    created_by_agent_id: 'alice/claude',
    status: 'active',
    type: 'dev',
    severity: null,
    fixed_at: null,
    iteration: null,
    closing_note: null,
    created_at: NOW - 2 * H,
    updated_at: NOW - 1 * H,
    claimed_at: NOW - 2 * H,
    closed_at: null,
    last_heartbeat_at: NOW - 1 * H,
    ...overrides,
  };
}

function run(tasks: TaskRow[], extra: Partial<Parameters<typeof computeStandup>[0]> = {}) {
  return computeStandup({
    tasks,
    depsByTask: new Map(),
    commentCounts: [],
    urgentComments: [],
    staleTtlHours: 8,
    now: NOW,
    windowHours: 24,
    ...extra,
  });
}

describe('computeStandup', () => {
  it('classifies completed/abandoned/started/planned within the window', () => {
    const report = run([
      task('t_done', { status: 'done', closed_at: NOW - 1 * H, claimed_at: NOW - 40 * H, closing_note: 'shipped' }),
      task('t_老done', { status: 'done', closed_at: NOW - 30 * H, claimed_at: NOW - 40 * H }), // outside window
      task('t_drop', { status: 'abandoned', closed_at: NOW - 2 * H, claimed_at: NOW - 40 * H, closing_note: 'dup' }),
      task('t_new', { claimed_at: NOW - 3 * H }),
      task('t_old', { claimed_at: NOW - 30 * H }), // started long ago
      task('t_backlog', { status: 'planned', owner_agent_id: null, claimed_at: null, created_at: NOW - 1 * H }),
    ]);
    const p = report.projects[0]!;
    expect(p.completed.map((r) => r.task_id)).toEqual(['t_done']);
    expect(p.abandoned.map((r) => r.task_id)).toEqual(['t_drop']);
    expect(p.started.map((r) => r.task_id)).toEqual(['t_new']);
    expect(p.planned_added.map((r) => r.task_id)).toEqual(['t_backlog']);
    expect(p.planned_added[0]!.owner_agent_id).toBeNull();
  });

  it('claim-then-close inside the window appears in both started and completed', () => {
    const report = run([
      task('t_fast', { status: 'done', claimed_at: NOW - 2 * H, closed_at: NOW - 1 * H }),
    ]);
    const p = report.projects[0]!;
    expect(p.started.map((r) => r.task_id)).toEqual(['t_fast']);
    expect(p.completed.map((r) => r.task_id)).toEqual(['t_fast']);
  });

  it('window boundary is strict: exactly at since is excluded', () => {
    const report = run([
      task('t_edge', { status: 'done', closed_at: NOW - 24 * H, claimed_at: NOW - 40 * H }),
    ]);
    expect(report.projects).toHaveLength(0);
  });

  it('blocked and stale are NOW facts, not window facts', () => {
    const deps = new Map<string, DepInfo[]>([
      ['t_blocked', [{ task_id: 't_pre', title: 'pre', status: 'active' }]],
      ['t_free', [{ task_id: 't_pre2', title: 'pre2', status: 'done' }]],
    ]);
    const report = run(
      [
        task('t_blocked', { created_at: NOW - 100 * H, claimed_at: NOW - 100 * H }),
        task('t_free', { created_at: NOW - 100 * H, claimed_at: NOW - 100 * H }),
        task('t_sleepy', { last_heartbeat_at: NOW - 20 * H, claimed_at: NOW - 100 * H }),
      ],
      { depsByTask: deps },
    );
    const p = report.projects[0]!;
    expect(p.blocked.map((r) => r.task_id)).toEqual(['t_blocked']);
    expect(p.blocked[0]!.blocked_by).toEqual(['t_pre']);
    expect(p.stale.map((r) => r.task_id)).toEqual(['t_sleepy']);
  });

  it('iteration filter adds the NOW-fact stock (week plans stay visible all week)', () => {
    const report = run(
      [
        // Registered far outside the window — invisible to window buckets, but still open stock.
        task('t_plan', { status: 'planned', claimed_at: null, created_at: NOW - 100 * H, iteration: '2026w24' }),
        task('t_doing', { claimed_at: NOW - 100 * H, iteration: '2026w24' }),
        task('t_wait', { status: 'fixed', type: 'bug', claimed_at: NOW - 100 * H, fixed_at: NOW - 50 * H, iteration: '2026w24' }),
        task('t_done', { status: 'done', closed_at: NOW - 50 * H, claimed_at: NOW - 100 * H, iteration: '2026w24' }),
      ],
      { iteration: '2026w24' },
    );
    const stock = report.iteration_stock!;
    expect(stock.iteration).toBe('2026w24');
    expect(stock.planned.map((r) => r.task_id)).toEqual(['t_plan']);
    expect(stock.active.map((r) => r.task_id)).toEqual(['t_doing']);
    expect(stock.fixed.map((r) => r.task_id)).toEqual(['t_wait']);
    expect(stock.planned[0]!.project).toBe('proj');
  });

  it('iteration_stock is null without an iteration filter', () => {
    expect(run([task('t_a')]).iteration_stock).toBeNull();
  });

  it('filters by project and iteration; counts notices per project', () => {
    const report = run(
      [
        task('t_a', { iteration: '2026w24' }),
        task('t_b', { iteration: '2026w25' }),
        task('t_x', { project: 'other' }),
      ],
      {
        iteration: '2026w24',
        project: 'proj',
        commentCounts: [
          { project: 'proj', kind: 'overlap_notice', n: 3 },
          { project: 'proj', kind: 'boundary_agreement', n: 1 },
          { project: 'other', kind: 'overlap_notice', n: 9 },
        ],
      },
    );
    expect(report.projects).toHaveLength(1);
    const p = report.projects[0]!;
    expect(p.project).toBe('proj');
    expect(p.overlap_notices).toBe(3);
    expect(p.boundary_agreements).toBe(1);
  });
});

describe('blockingDeps truth table', () => {
  it('planned/active/fixed block (unverified != resolved); done/abandoned do not', () => {
    const deps: DepInfo[] = [
      { task_id: 'a', title: '', status: 'planned' },
      { task_id: 'b', title: '', status: 'active' },
      { task_id: 'e', title: '', status: 'fixed' },
      { task_id: 'c', title: '', status: 'done' },
      { task_id: 'd', title: '', status: 'abandoned' },
    ];
    expect(blockingDeps(deps).map((d) => d.task_id)).toEqual(['a', 'b', 'e']);
  });
});
