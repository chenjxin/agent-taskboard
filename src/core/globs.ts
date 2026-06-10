/**
 * Path-glob normalization and pair intersection.
 *
 * Bias rule: when uncertain, report an intersection. A false positive costs a
 * glance and maybe one comment; a false negative costs the merge conflict this
 * system exists to prevent.
 */
import picomatch from 'picomatch';
import { BoardError } from './errors.js';

const MAGIC_RE = /[*?[\]{}()!]/;

/** Backslashes -> '/', collapse '//', strip leading './' and trailing '/', lowercase. */
export function normalizePath(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/+$/, '');
  return p.toLowerCase();
}

/**
 * Reject inputs that can never match repo-relative globs (silent false
 * negatives are the worst failure mode for this product).
 */
export function validateScopePath(raw: string): void {
  const cleaned = raw.trim().replace(/\\/g, '/');
  if (cleaned.startsWith('/')) {
    throw new BoardError('INVALID_SCOPE_PATH', `Absolute path not allowed: '${raw}'`);
  }
  if (/^[a-z]:\//i.test(cleaned)) {
    throw new BoardError('INVALID_SCOPE_PATH', `Drive-letter path not allowed: '${raw}'`);
  }
  if (cleaned.split('/').includes('..')) {
    throw new BoardError('INVALID_SCOPE_PATH', `'..' segments not allowed: '${raw}'`);
  }
  const normalized = normalizePath(raw);
  if (normalized === '' || normalized === '.') {
    throw new BoardError('INVALID_SCOPE_PATH', `Empty path: '${raw}'`);
  }
}

export function hasMagic(p: string): boolean {
  return MAGIC_RE.test(p);
}

interface Expanded {
  kind: 'literal' | 'glob';
  /** Wildcard-free literal prefix; '' means "matches from the repo root". */
  base: string;
  source: string;
}

function expand(p: string): Expanded {
  const n = normalizePath(p);
  if (!MAGIC_RE.test(n)) {
    // A bare literal counts as itself AND its subtree ('src/auth' ~ 'src/auth/**');
    // a literal file path is just a 1-element subtree — same rule, no file-vs-dir guessing.
    return { kind: 'literal', base: n, source: n };
  }
  return { kind: 'glob', base: normalizePath(picomatch.scan(n).base), source: n };
}

/** Globs whose literal prefix is the repo root ('**', '*', '**\/*.test.ts') overlap with everything. */
export function isBroadGlob(p: string): boolean {
  const e = expand(p);
  return e.kind === 'glob' && e.base === '';
}

/** Segment-aware containment: 'src/auth' contains 'src/auth/x' but not 'src/authx'. */
function prefixContains(a: string, b: string): boolean {
  return a === b || b.startsWith(a + '/') || a.startsWith(b + '/');
}

/** Symmetric: do these two declared paths/globs plausibly touch common files? */
export function pathPairIntersects(mine: string, theirs: string): boolean {
  const a = expand(mine);
  const b = expand(theirs);
  // Empty-base glob matches from the repo root: contains everything (and is flagged broad).
  if ((a.kind === 'glob' && a.base === '') || (b.kind === 'glob' && b.base === '')) return true;
  if (a.kind === b.kind) {
    // literal+literal: subtree containment; glob+glob: literal-prefix containment (FP-biased).
    return prefixContains(a.base, b.base);
  }
  const glob = a.kind === 'glob' ? a : b;
  const literal = a.kind === 'literal' ? a : b;
  if (picomatch(glob.source, { dot: true, nocase: true })(literal.base)) return true;
  // Containment rescue, FP-biased: literal 'src' vs glob 'src/**/*.ts' -> true.
  return prefixContains(literal.base, glob.base);
}
