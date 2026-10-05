export interface Column<T> {
  key: string;
  header: string;
  text?: (row: T) => string;
  numeric?: boolean;
  primary?: boolean;
  status?: boolean;
  sortField?: string;
}

export interface SortState {
  field: string;
  dir: 'asc' | 'desc';
}

export function parseSort(value: string | null | undefined): SortState | null {
  const m = /^(\w+),(asc|desc)$/.exec(value ?? '');
  return m ? { field: m[1]!, dir: m[2] as 'asc' | 'desc' } : null;
}

export function formatSort(s: SortState): string {
  return `${s.field},${s.dir}`;
}

export interface TableSelection<T> {
  selected: ReadonlySet<string>;
  onchange: (next: Set<string>) => void;
  allLabel: string;
  rowLabel: (row: T) => string;
  errorId?: string | null;
}

export function ariaSort(col: { sortField?: string }, sort: SortState | null | undefined) {
  if (!col.sortField) return undefined;
  if (sort?.field !== col.sortField) return 'none' as const;
  return sort.dir === 'asc' ? ('ascending' as const) : ('descending' as const);
}
