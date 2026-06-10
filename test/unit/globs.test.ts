import { describe, expect, it } from 'vitest';
import { BoardError } from '../../src/core/errors.js';
import {
  hasMagic,
  isBroadGlob,
  normalizePath,
  pathPairIntersects,
  validateScopePath,
} from '../../src/core/globs.js';

// [mine, theirs, expected, why]
const PAIR_TABLE: Array<[string, string, boolean, string]> = [
  ['src/auth', 'src/auth', true, 'bare dir vs itself'],
  ['src/auth', 'src/auth/login.ts', true, 'file under bare dir (dir expands to subtree)'],
  ['src/auth/login.ts', 'src/auth', true, 'file inside dir, reversed'],
  ['src/auth/**', 'src/auth/sso/*.ts', true, 'glob+glob base containment'],
  ['src/**/*.ts', 'src/billing/invoice.ts', true, 'one side wildcard-free: real picomatch test'],
  ['**', 'src/x', true, 'broad glob hits everything'],
  ['src/*.ts', 'src/utils/helper.ts', true, 'bias-to-false-positive: shallow glob base contains literal'],
  ['./src/auth/', 'src/auth', true, 'normalization: leading ./ and trailing /'],
  ['SRC/Auth', 'src/auth', true, 'case-insensitive comparison'],
  ['**/*.test.ts', 'src/**', true, 'empty static base contains everything (documented FP)'],
  ['src/auth/sso/**', 'src', true, 'deep glob vs shallow literal: containment'],
  ['src\\auth\\login.ts', 'src/auth', true, 'windows backslashes normalized'],
  ['src/auth', 'src/authx', false, 'segment-aware prefix: auth != authx'],
  ['src/**/*.ts', 'docs/readme.md', false, 'picomatch miss + disjoint bases'],
  ['packages/api/**', 'packages/web/**', false, 'disjoint glob bases'],
  ['src/auth/login.ts', 'src/auth/logout.ts', false, 'two distinct literal files'],
  ['src/auth/**', 'src/billing/login.ts', false, 'glob vs non-matching literal'],
];

describe('pathPairIntersects', () => {
  for (const [mine, theirs, expected, why] of PAIR_TABLE) {
    it(`${JSON.stringify(mine)} vs ${JSON.stringify(theirs)} -> ${expected} (${why})`, () => {
      expect(pathPairIntersects(mine, theirs)).toBe(expected);
    });
    it(`symmetric: ${JSON.stringify(theirs)} vs ${JSON.stringify(mine)} -> ${expected}`, () => {
      expect(pathPairIntersects(theirs, mine)).toBe(expected);
    });
  }
});

describe('normalizePath', () => {
  it('strips ./ and trailing /, collapses //, lowercases, converts backslashes', () => {
    expect(normalizePath('./src/auth/')).toBe('src/auth');
    expect(normalizePath('SRC//Auth')).toBe('src/auth');
    expect(normalizePath('src\\auth\\login.ts')).toBe('src/auth/login.ts');
  });
});

describe('validateScopePath', () => {
  const REJECTED = ['/abs/path', 'C:\\code\\x', '../shared/**', 'a/../b', '', '   ', '.'];
  for (const raw of REJECTED) {
    it(`rejects ${JSON.stringify(raw)} with INVALID_SCOPE_PATH`, () => {
      try {
        validateScopePath(raw);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(BoardError);
        expect((e as BoardError).error_code).toBe('INVALID_SCOPE_PATH');
        expect((e as BoardError).next_call_hint).toBeTruthy();
      }
    });
  }
  it('accepts repo-relative paths and globs', () => {
    expect(() => validateScopePath('src/auth/**')).not.toThrow();
    expect(() => validateScopePath('README.md')).not.toThrow();
    expect(() => validateScopePath('src\\auth')).not.toThrow();
  });
});

describe('isBroadGlob', () => {
  const TABLE: Array<[string, boolean]> = [
    ['**', true],
    ['*', true],
    ['**/*.test.ts', true],
    ['src/**', false],
    ['src/auth', false],
  ];
  for (const [glob, expected] of TABLE) {
    it(`${JSON.stringify(glob)} -> ${expected}`, () => {
      expect(isBroadGlob(glob)).toBe(expected);
    });
  }
});

describe('hasMagic', () => {
  it('detects glob metacharacters', () => {
    expect(hasMagic('src/**')).toBe(true);
    expect(hasMagic('src/*.ts')).toBe(true);
    expect(hasMagic('src/auth')).toBe(false);
    expect(hasMagic('src/auth/login.ts')).toBe(false);
  });
});
