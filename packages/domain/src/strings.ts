/**
 * Compares two strings by Unicode code point (R21, R92) — the order every tie-break and fixed order in the
 * contract uses, identical to PostgreSQL `COLLATE "C"`, UTF-8 byte order, Python `<` and PHP `strcmp`.
 * JavaScript's `<` compares UTF-16 code units, which puts astral characters (surrogate pairs, U+D800–U+DFFF
 * units) before U+E000–U+FFFF; `localeCompare` is locale-dependent. Returns -1, 0 or 1.
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++; // both strings share the same surrogate pair here
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
