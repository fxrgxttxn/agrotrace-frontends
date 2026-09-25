import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiProblem } from '@agrotrace/api-client';
import { formatSort, parseSort, type SortState } from '../ui/Table';

// Table state lives in the URL (spec §9.3): `page`, `sort` (`field,dir`, as x-sort) and the screen's filters. Any
// filter or sort change starts again from page 1; pagination links keep every other parameter (README «Пагинация»).
// A URL is typed or pasted by people (ruling F11): parameters the screen does not accept — a sort field outside
// x-sort, an unknown enum value, a malformed date or id, a page that is not a positive integer — are dropped from the
// URL (replace) and never sent, so a bad link does not end in a 400.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ListSpec {
  /** x-sort fields of the operation. */
  sort: readonly string[];
  /** Enum parameters (a repeated one keeps only the allowed values). */
  enums?: Record<string, readonly string[]>;
  uuids?: readonly string[];
  /** `YYYY-MM-DD` parameters (valid calendar dates). */
  dates?: readonly string[];
  /** Other parameters with their own pattern. */
  patterns?: Record<string, RegExp>;
  /** Free text (`q`). */
  texts?: readonly string[];
}

function validDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function ownKeys(spec: ListSpec): Set<string> {
  return new Set([
    'page',
    'sort',
    ...Object.keys(spec.enums ?? {}),
    ...(spec.uuids ?? []),
    ...(spec.dates ?? []),
    ...Object.keys(spec.patterns ?? {}),
    ...(spec.texts ?? []),
  ]);
}

/** The URL parameters the screen accepts; everything else of the list is dropped. Parameters that are not the
 * list's (e.g. `tab`) are kept as they are. */
export function sanitizeParams(params: URLSearchParams, spec: ListSpec): URLSearchParams {
  const out = new URLSearchParams();
  const own = ownKeys(spec);
  for (const [k, v] of params) if (!own.has(k)) out.append(k, v);
  const page = params.get('page');
  if (page !== null && /^[1-9]\d{0,6}$/.test(page) && page !== '1') out.set('page', page);
  const sort = parseSort(params.get('sort'));
  if (sort && spec.sort.includes(sort.field)) out.set('sort', formatSort(sort));
  for (const [key, allowed] of Object.entries(spec.enums ?? {}))
    for (const v of new Set(params.getAll(key))) if (allowed.includes(v)) out.append(key, v);
  for (const key of spec.uuids ?? []) {
    const v = params.get(key);
    if (v && UUID.test(v)) out.set(key, v);
  }
  for (const key of spec.dates ?? []) {
    const v = params.get(key);
    if (v && validDate(v)) out.set(key, v);
  }
  for (const [key, re] of Object.entries(spec.patterns ?? {})) {
    const v = params.get(key);
    if (v && re.test(v)) out.set(key, v);
  }
  for (const key of spec.texts ?? []) {
    const v = params.get(key);
    if (v) out.set(key, v);
  }
  return out;
}

const sameParams = (a: URLSearchParams, b: URLSearchParams) => {
  const s = (p: URLSearchParams) =>
    [...p]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('&');
  return s(a) === s(b);
};

export interface ListParams {
  params: URLSearchParams;
  page: number;
  sort: SortState | null;
  /** A single-valued parameter (`''` when absent). */
  get: (key: string) => string;
  /** Sets (or, for `null` / `''` / `[]`, removes) parameters and goes back to page 1. */
  set: (patch: Record<string, string | string[] | null | undefined>) => void;
  setSort: (next: SortState) => void;
  hrefFor: (page: number) => string;
  /** Removes every list parameter (search, filters, sort, page). */
  reset: () => void;
  /** A page past the end (a list that shrank, an old link): go to the last page instead of an empty one. */
  clampPage: (total: number, size: number) => void;
}

export function useListParams(path: string, spec: ListSpec): ListParams {
  const [raw, setParams] = useSearchParams();
  const params = useMemo(() => sanitizeParams(raw, spec), [raw, spec]);
  const dirty = !sameParams(params, raw);
  useEffect(() => {
    if (dirty) setParams(params, { replace: true });
  }, [dirty, params, setParams]);
  const page = Math.max(1, Number(params.get('page')) || 1);
  const sort = parseSort(params.get('sort'));

  const set = useCallback(
    (patch: Record<string, string | string[] | null | undefined>) => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        for (const [k, v] of Object.entries(patch)) {
          next.delete(k);
          if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
          else if (v !== null && v !== undefined && v !== '') next.set(k, v);
        }
        next.delete('page');
        return next;
      });
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
      reset: () =>
        setParams((current) => {
          const own = ownKeys(spec);
          const keep = new URLSearchParams();
          for (const [k, v] of current) if (!own.has(k)) keep.append(k, v);
          return keep;
        }),
      clampPage: (total: number, size: number) => {
        const last = Math.max(1, Math.ceil(total / size));
        if (page <= last) return;
        setParams(
          (current) => {
            const next = new URLSearchParams(current);
            if (last > 1) next.set('page', String(last));
            else next.delete('page');
            return next;
          },
          { replace: true },
        );
      },
    }),
    [params, page, sort, set, path, setParams, spec],
  );
}

/** A list request the server rejected as invalid (400): the screen offers «Сбросить фильтры». */
export function isBadListQuery(e: unknown): boolean {
  return e instanceof ApiProblem && e.status === 400;
}
