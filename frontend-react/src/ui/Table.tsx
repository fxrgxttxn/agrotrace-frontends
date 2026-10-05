import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { t } from '../app/i18n';
import { Checkbox } from './Check';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
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
  onChange: (next: Set<string>) => void;
  allLabel: string;
  rowLabel: (row: T) => string;
  errorId?: string | null;
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption?: string;
  cards?: boolean;
  sort?: SortState | null;
  onSort?: (next: SortState) => void;
  sortOptions?: { value: string; label: string }[];
  selection?: TableSelection<T>;
  actions?: (row: T) => ReactNode;
}

function ariaSort(col: { sortField?: string }, sort: SortState | null | undefined) {
  if (!col.sortField) return undefined;
  if (sort?.field !== col.sortField) return 'none' as const;
  return sort.dir === 'asc' ? ('ascending' as const) : ('descending' as const);
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  cards,
  sort,
  onSort,
  sortOptions,
  selection,
  actions,
}: TableProps<T>) {
  const keys = rows.map(rowKey);
  const selectedCount = selection ? keys.filter((k) => selection.selected.has(k)).length : 0;
  const all = rows.length > 0 && selectedCount === rows.length;
  const some = selectedCount > 0 && !all;
  const toggleAll = () => selection?.onChange(all ? new Set() : new Set(keys));
  const toggle = (k: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    selection.onChange(next);
  };
  const sortBy = (field: string) =>
    onSort?.({ field, dir: sort?.field === field && sort.dir === 'asc' ? 'desc' : 'asc' });

  return (
    <>
      {cards && (selection || sortOptions) && (
        <div className="at-table-mobilebar">
          {selection && (
            <Checkbox checked={all} indeterminate={some} onChange={toggleAll}>
              {t('ui.selectAll')}
            </Checkbox>
          )}
          {sortOptions && (
            <label className="at-table-mobilebar__sort">
              <span className="at-visually-hidden">{t('ui.sort')}</span>
              <select
                className="at-select"
                value={sort ? formatSort(sort) : ''}
                onChange={(e) => {
                  const s = parseSort(e.target.value);
                  if (s) onSort?.(s);
                }}
              >
                {!sort && (
                  <option value="" disabled>
                    {t('ui.sortDefault')}
                  </option>
                )}
                {sortOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      <div className="at-table-wrap">
        <table className="at-table" data-cards={cards ? '' : undefined}>
          {caption && <caption className="at-visually-hidden">{caption}</caption>}
          <thead>
            <tr>
              {selection && (
                <th className="at-table__select" scope="col">
                  <Checkbox
                    checked={all}
                    indeterminate={some}
                    onChange={toggleAll}
                    aria-label={selection.allLabel}
                  />
                </th>
              )}
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  data-numeric={c.numeric ? '' : undefined}
                  aria-sort={ariaSort(c, sort)}
                >
                  {c.sortField ? (
                    <button className="at-table__sort" type="button" onClick={() => sortBy(c.sortField!)}>
                      {c.header}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
              {actions && (
                <th scope="col">
                  <span className="at-visually-hidden">{t('ui.actions')}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const k = rowKey(row);
              const on = selection?.selected.has(k) ?? false;
              return (
                <tr key={k} data-selected={on ? '' : undefined}>
                  {selection && (
                    <td className="at-table__select">
                      <Checkbox
                        checked={on}
                        onChange={() => toggle(k)}
                        aria-label={selection.rowLabel(row)}
                        aria-invalid={selection.errorId ? 'true' : undefined}
                        aria-describedby={selection.errorId ?? undefined}
                      />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      data-label={c.header}
                      data-primary={c.primary ? '' : undefined}
                      data-status-cell={c.status ? '' : undefined}
                      data-numeric={c.numeric ? '' : undefined}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                  {actions && <td className="at-table__actions">{actions(row)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function TablePrimary({ to, code, sub }: { to: string; code: string; sub?: ReactNode }) {
  return (
    <span className="at-table__primary">
      <Link className="at-mono" to={to}>
        {code}
      </Link>
      {sub !== undefined && <span className="at-table__sub">{sub}</span>}
    </span>
  );
}
