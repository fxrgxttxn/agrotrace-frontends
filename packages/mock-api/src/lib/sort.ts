/**
 * List ordering by the contract's rules (info.description "Списки"): by the chosen key, null always last, ties by
 * `id` ascending; strings compare by Unicode code points (`compareCodePoints`), decimals exactly
 * (`compareDecimalStrings`), instants by time.
 */
import { compareCodePoints, compareDecimalStrings } from '@agrotrace/domain';

export type SortValue = string | number | null | undefined;
export type Kind = 'text' | 'number' | 'decimal' | 'time';

export function compareValues(a: SortValue, b: SortValue, kind: Kind): number {
  switch (kind) {
    case 'text':
      return compareCodePoints(String(a), String(b));
    case 'number':
      return Number(a) - Number(b);
    case 'decimal':
      return compareDecimalStrings(String(a), String(b));
    case 'time':
      return Date.parse(String(a)) - Date.parse(String(b));
  }
}

/** Sorts `items` (a copy) by `key` in `dir`, nulls last, then by `id` (code points). */
export function sortBy<T extends { id: string }>(
  items: T[],
  key: (x: T) => SortValue,
  kind: Kind,
  dir: 'asc' | 'desc',
): T[] {
  return [...items].sort((x, y) => {
    const a = key(x);
    const b = key(y);
    const an = a === null || a === undefined;
    const bn = b === null || b === undefined;
    if (an !== bn) return an ? 1 : -1;
    if (!an && !bn) {
      const c = compareValues(a, b, kind);
      if (c !== 0) return dir === 'asc' ? c : -c;
    }
    return compareCodePoints(x.id, y.id);
  });
}

/** Case-insensitive substring (`q`): `%`, `_`, `\` are ordinary characters. */
export const contains = (haystack: string | null | undefined, needle: string): boolean =>
  (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
