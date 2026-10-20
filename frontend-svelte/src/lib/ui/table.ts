export interface Column<T> {
  key: string;
  /** Header text; also the `data-label` of the cells (card mode). */
  header: string;
  /** Plain text of a cell (the table's `cell` snippet renders richer content). */
  text?: (row: T) => string;
  numeric?: boolean;
  /** First line of a card: the primary cell (code + sub line). */
  primary?: boolean;
  /** First line of a card: the status chip cell. */
  status?: boolean;
  /** Sort field in the URL (`sort=<field>,<dir>`); makes the header a sort button. */
  sortField?: string;
}

/** Sort as the contract writes it: `field,asc|desc` (x-sort). */
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
  /** `aria-label` of the header box, e.g. «Выбрать все партии». */
  allLabel: string;
  /** `aria-label` of a row box, e.g. «Выбрать AT-2026-000123». */
  rowLabel: (row: T) => string;
  /** Id of the error of the choice (nothing picked, README «Таблица»): every row box is `aria-invalid` and described
   * by it, so the first box takes the focus of a failed submit. */
  errorId?: string | null;
}

export function ariaSort(col: { sortField?: string }, sort: SortState | null | undefined) {
  if (!col.sortField) return undefined;
  if (sort?.field !== col.sortField) return 'none' as const;
  return sort.dir === 'asc' ? ('ascending' as const) : ('descending' as const);
}
