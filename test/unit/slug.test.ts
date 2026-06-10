import { describe, expect, it } from 'vitest';
import { didYouMean, normalizeProjectSlug } from '../../src/core/slug.js';

describe('normalizeProjectSlug', () => {
  const TABLE: Array<[string, string]> = [
    ['git@github.com:team/Todo-List.git', 'todo-list'],
    ['https://host/a/b/Repo.git', 'repo'],
    ['/home/me/proj/', 'proj'],
    ['proj', 'proj'],
    ['My-Project', 'my-project'],
  ];
  for (const [raw, expected] of TABLE) {
    it(`${JSON.stringify(raw)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeProjectSlug(raw).slug).toBe(expected);
    });
  }

  it('reports whether normalization changed the input', () => {
    expect(normalizeProjectSlug('proj').changed).toBe(false);
    expect(normalizeProjectSlug('Proj').changed).toBe(true);
    expect(normalizeProjectSlug('git@h:t/Proj.git').changed).toBe(true);
  });
});

describe('didYouMean', () => {
  it('flags near-miss slugs (edit distance <= 2)', () => {
    expect(didYouMean('todolist', ['todo-list', 'other'])).toEqual(['todo-list']);
  });
  it('flags containment (web vs web-app)', () => {
    expect(didYouMean('web', ['web-app'])).toEqual(['web-app']);
  });
  it('returns empty for unrelated slugs', () => {
    expect(didYouMean('alpha', ['omega'])).toEqual([]);
  });
  it('never flags the identical slug', () => {
    expect(didYouMean('proj', ['proj'])).toEqual([]);
  });
});
