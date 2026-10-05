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

export const contains = (haystack: string | null | undefined, needle: string): boolean =>
  (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
