import { describe, expect, it } from 'vitest';
import type { TaskRow } from '../../src/core/types.js';
import { makeTestBoard, registerArgs } from './helpers.js';

describe('register_task', () => {
  it('persists the task with scope rows and returns it with an overlap report', async () => {
    const b = await makeTestBoard();
    const out = await b.callOk('register_task', registerArgs());
    const task = out['task'] as TaskRow;
    expect(task.id).toMatch(/^t_/);
    expect(task.status).toBe('active');
    expect(task.owner_agent_id).toBe('alice/claude');

    const dbTask = b.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRow;
    expect(dbTask.title).toBe('migrate auth session storage');
    const scopeRows = b.db.prepare('SELECT * FROM scopes WHERE task_id = ?').all(task.id);
    expect(scopeRows).toHaveLength(1);

    const report = out['overlap_report'] as Record<string, unknown>;
    expect(report['counterparts']).toEqual([]);
    expect(out['next_step']).toContain('.claude/board-task.json');
  });

  it('normalizes the project slug and reports the change', async () => {
    const b = await makeTestBoard();
    const out = await b.callOk(
      'register_task',
      registerArgs({ project: 'git@github.com:team/My-Proj.git' }),
    );
    expect(out['normalized_project']).toEqual({ slug: 'my-proj', changed: true });
    expect((out['task'] as TaskRow).project).toBe('my-proj');
  });

  it('warns did_you_mean when a near-miss slug already has active tasks', async () => {
    const b = await makeTestBoard();
    await b.callOk('register_task', registerArgs({ project: 'todo-list' }));
    const out = await b.callOk(
      'register_task',
      registerArgs({ agent_id: 'bob/claude', project: 'todolist', scope: [{ path_glob: 'docs/**' }] }),
    );
    const warnings = out['warnings'] as Record<string, unknown>;
    expect(warnings['did_you_mean']).toEqual(['todo-list']);
  });

  it('hints when the same owner registers an overlapping task in the same project', async () => {
    const b = await makeTestBoard();
    const first = await b.callOk('register_task', registerArgs());
    const firstId = (first['task'] as TaskRow).id;
    const out = await b.callOk('register_task', registerArgs({ title: 'second auth task' }));
    const warnings = out['warnings'] as Record<string, unknown>;
    expect(warnings['duplicate_task_hint']).toContain(firstId);
  });

  it('warns when no scope is declared', async () => {
    const b = await makeTestBoard();
    const out = await b.callOk('register_task', registerArgs({ scope: [] }));
    const warnings = out['warnings'] as Record<string, unknown>;
    expect(warnings['no_scope_warning']).toContain('UNKNOWN');
  });

  it('rejects a scope row with neither path_glob nor module', async () => {
    const b = await makeTestBoard();
    const err = await b.callErr('register_task', registerArgs({ scope: [{ note: 'just a note' }] }));
    expect(err['error_code']).toBe('EMPTY_SCOPE_ROW');
    expect(err['next_call_hint']).toBeTruthy();
  });

  it('rejects absolute and parent-escaping scope paths with INVALID_SCOPE_PATH', async () => {
    const b = await makeTestBoard();
    for (const bad of ['/etc/passwd', '../other-repo/**']) {
      const err = await b.callErr('register_task', registerArgs({ scope: [{ path_glob: bad }] }));
      expect(err['error_code']).toBe('INVALID_SCOPE_PATH');
    }
  });

  it('exposes all 8 tools and the server instructions', async () => {
    const b = await makeTestBoard();
    const tools = await b.client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'add_comment',
      'check_overlap',
      'get_task',
      'heartbeat',
      'list_tasks',
      'register_task',
      'update_scope',
      'update_status',
    ]);
    const readOnly = tools.tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(['check_overlap', 'get_task', 'list_tasks']);
    expect(b.client.getInstructions()).toContain('never assigns');
  });
});
