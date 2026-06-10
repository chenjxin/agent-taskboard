/**
 * Project slug normalization + near-miss detection.
 *
 * Slug mismatch ('reload-front' vs 'reload_front') silently disables overlap
 * detection for the whole project, so the server normalizes every incoming
 * project value and warns when a new slug merely resembles an existing one.
 */

/** Lowercase basename of a repo URL/path, '.git' stripped. */
export function normalizeProjectSlug(raw: string): { slug: string; changed: boolean } {
  const trimmed = raw.trim();
  let s = trimmed.replace(/\/+$/, '');
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
  if (cut >= 0) s = s.slice(cut + 1);
  s = s.replace(/\.git$/i, '').toLowerCase();
  return { slug: s, changed: s !== trimmed };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Known slugs that look suspiciously close to `slug` (edit distance <= 2 or containment). */
export function didYouMean(slug: string, knownSlugs: string[]): string[] {
  return knownSlugs.filter(
    (k) => k !== slug && (levenshtein(k, slug) <= 2 || k.includes(slug) || slug.includes(k)),
  );
}
