import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatSort, parseSort, type SortState } from '../ui/Table';

// Table state lives in the URL (spec §9.3): `page`, `sort` (`field,dir`, as x-sort) and the screen's filters. Any
// filter or sort change starts again from page 1; pagination links keep every other parameter (README «Пагинация»).

export interface ListParams {
  params: URLSearchParams;
  page: number;
  sort: SortState | null;
  /** A single-valued parameter (`''` when absent). */
  get: (key: string) => string;
  /** Sets (or, for `null` / `''`, removes) parameters and goes back to page 1. */
  set: (patch: Record<string, string | null | undefined>) => void;
  setSort: (next: SortState) => void;
  hrefFor: (page: number) => string;
}

export function useListParams(path: string): ListParams {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const sort = parseSort(params.get('sort'));

  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === undefined || v === '') next.delete(k);
            else next.set(k, v);
          }
          next.delete('page');
          return next;
        },
        { replace: false },
      );
    },
    [setParams],
  );

  return useMemo(
    () => ({
      params,
      page,
      sort,
      get: (key: string) => params.get(key) ?? '',
      set,
      setSort: (next: SortState) => set({ sort: formatSort(next) }),
      hrefFor: (p: number) => {
        const q = new URLSearchParams(params);
        if (p > 1) q.set('page', String(p));
        else q.delete('page');
        const s = q.toString();
        return `${path}${s ? `?${s}` : ''}`;
      },
    }),
    [params, page, sort, set, path],
  );
}
