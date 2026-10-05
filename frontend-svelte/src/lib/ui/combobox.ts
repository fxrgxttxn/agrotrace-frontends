export interface ComboOption {
  value: string;
  label: string;
  meta?: string;
  disabled?: boolean;
}

export const SEARCH_DELAY_MS = 250;

export function highlight(label: string, query: string): [string, string, string] | null {
  const q = query.trim();
  const at = q ? label.toLocaleLowerCase('ru').indexOf(q.toLocaleLowerCase('ru')) : -1;
  if (at < 0) return null;
  return [label.slice(0, at), label.slice(at, at + q.length), label.slice(at + q.length)];
}
