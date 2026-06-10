import { describe, expect, it } from 'vitest';
import type { CommentRow, OverlapCounterpart, TaskRow } from '../../src/core/types.js';
import { makeTestBoard, registerArgs } from './helpers.js';

function notices(b: Awaited<ReturnType<typeof makeTestBoard>>, taskId: string): CommentRow[] {
  return b.db
    .prepare(`SELECT * FROM comments WHERE task_id = ? AND kind = 'overlap_notice' ORDER BY id`)
    .all(taskId) as CommentRow[];
}

describe('two agents colliding', () => {
  it('check_overlap is a true dry run; register_task posts symmetric notices once', async () => {
    const b = await makeTestBoard();
    const a = await b.callOk('register_task', registerArgs());
    const aId = (a['task'] as TaskRow).id;

    // B checks before starting: HIGH + the four user-required context fields about A.
    const check = await b.callOk('check_overlap', {
      agent_id: 'bob/claude',
      project: 'proj',
      scope: [{ path_glob: 'src/auth/sso/**' }],
    });
    const report = check['overlap_report'] as { counterparts: OverlapCounterpart[] };
    expect(report.counterparts).toHaveLength(1);
    const row = report.counterparts[0]!;
    expect(row.severity).toBe('HIGH');
    expect(row.task_id).toBe(aId);
    expect(row.owner_agent_id).toBe('alice/claude');
    expect(row.title).toBe('migrate auth session storage');
    expect(row.description).toContain('redis');
    expect(row.updated_at).toBeGreaterThan(0);
    expect(row.next_step).toContain('add_comment');

    // Dry-run guarantee: no comments, no tasks, nothing recorded.
    expect(notices(b, aId)).toHaveLength(0);
    expect(b.db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 1 });

    // B registers: symmetric overlap notices on BOTH tasks.
    const breg = await b.callOk('register_task', registerArgs({
      agent_id: 'bob/claude',
      title: 'sso login flow',
      scope: [{ path_glob: 'src/auth/sso/**' }],
    }));
    const bId = (breg['task'] as TaskRow).id;
    expect((breg['overlap_report'] as { counterparts: OverlapCounterpart[] }).counterparts[0]!.severity).toBe('HIGH');

    const aNotices = notices(b, aId);
    const bNotices = notices(b, bId);
    expect(aNotices).toHaveLength(1);
    expect(bNotices).toHaveLength(1);
    expect(aNotices[0]!.author_agent_id).toBe('system');
    expect(aNotices[0]!.body).toContain(`OVERLAP HIGH task:${bId}`);
    expect(bNotices[0]!.body).toContain(`OVERLAP HIGH task:${aId}`);
    expect(bNotices[0]!.body).toContain('alice/claude');
  });

  it('dedupes notices per task pair: same severity never re-posts, escalation does', async () => {
    const b = await makeTestBoard();
    const a = await b.callOk('register_task', registerArgs());
    const aId = (a['task'] as TaskRow).id;
    const breg = await b.callOk('register_task', registerArgs({
      agent_id: 'bob/claude',
      title: 'auth module survey',
      scope: [{ path_glob: 'docs/auth/**', module: 'auth' }], // module-only -> MEDIUM
    }));
    const bId = (breg['task'] as TaskRow).id;
    expect(notices(b, aId)).toHaveLength(1); // MEDIUM notice

    // Same severity again (scope tweak that stays MEDIUM): no new notice.
    await b.callOk('update_scope', {
      agent_id: 'bob/claude',
      task_id: bId,
      scope: [{ path_glob: 'docs/auth/guide/**', module: 'auth' }],
    });
    expect(notices(b, aId)).toHaveLength(1);
    expect(notices(b, bId)).toHaveLength(1);

    // Escalation MEDIUM -> HIGH: one more notice on both threads.
    await b.callOk('update_scope', {
      agent_id: 'bob/claude',
      task_id: bId,
      scope: [{ path_glob: 'src/auth/login.ts', module: 'auth' }],
    });
    expect(notices(b, aId)).toHaveLength(2);
    expect(notices(b, bId)).toHaveLength(2);
    expect(notices(b, aId)[1]!.body).toContain('OVERLAP HIGH');
  });

  it('register_task is atomic: a failure mid-transaction leaves zero rows', async () => {
    const b = await makeTestBoard();
    await b.callOk('register_task', registerArgs());
    // Force the symmetric-notice insert (last write of the transaction) to fail.
    b.db.exec(`CREATE TRIGGER fail_notice BEFORE INSERT ON comments
               WHEN NEW.kind = 'overlap_notice'
               BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const err = await b.callErr('register_task', registerArgs({
      agent_id: 'bob/claude',
      title: 'colliding task',
      scope: [{ path_glob: 'src/auth/**' }],
    }));
    expect(err['message']).toContain('boom');
    // Rollback: B's task and scopes must not exist; A untouched.
    expect(b.db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 1 });
    expect(b.db.prepare(`SELECT COUNT(*) AS n FROM scopes`).get()).toEqual({ n: 1 });
    expect(b.db.prepare(`SELECT COUNT(*) AS n FROM comments`).get()).toEqual({ n: 0 });
  });

  it('update_scope is owner-only and returns a fresh report', async () => {
    const b = await makeTestBoard();
    const a = await b.callOk('register_task', registerArgs());
    const aId = (a['task'] as TaskRow).id;
    const err = await b.callErr('update_scope', {
      agent_id: 'bob/claude',
      task_id: aId,
      scope: [{ path_glob: 'src/**' }],
    });
    expect(err['error_code']).toBe('NOT_TASK_OWNER');
    expect(err['next_call_hint']).toContain('add_comment');

    const ok = await b.callOk('update_scope', {
      agent_id: 'alice/claude',
      task_id: aId,
      scope: [{ path_glob: 'src/auth/session/**' }, { path_glob: '**' }],
    });
    expect((ok['warnings'] as Record<string, unknown>)['broad_globs']).toEqual(['**']);
    const scopeRows = b.db.prepare(`SELECT path_glob FROM scopes WHERE task_id = ? ORDER BY id`).all(aId);
    expect(scopeRows).toHaveLength(2);
  });
});
