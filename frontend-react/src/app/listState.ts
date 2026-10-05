import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiProblem } from '@agrotrace/api-client';
import { formatSort, parseSort, type SortState } from '../ui/Table';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 100;

export interface ListSpec {
  sort: readonly string[];
  enums?: Record<string, readonly string[]>;
  uuids?: readonly string[];
  dates?: readonly string[];
  patterns?: Record<string, RegExp>;
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
    if (v) out.set(key, [...v].slice(0, TEXT_MAX).join(''));
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
  get: (key: string) => string;
  set: (patch: Record<string, string | string[] | null | undefined>) => void;
  setSort: (next: SortState) => void;
  hrefFor: (page: number) => string;
  reset: () => void;
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
      reset: () => {
        setParams((current) => {
          const own = ownKeys(spec);
          const keep = new URLSearchParams();
          for (const [k, v] of current) if (!own.has(k)) keep.append(k, v);
          return keep;
        });
        document.querySelector<HTMLElement>('h1.at-page__title')?.focus({ preventScroll: true });
      },
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

export function listGap(
  data: { items: readonly unknown[]; total: number },
  page: number,
  size: number,
): 'pastEnd' | 'changed' | null {
  if (data.items.length > 0 || data.total === 0) return null;
  return page > Math.max(1, Math.ceil(data.total / size)) ? 'pastEnd' : 'changed';
}

export function isBadListQuery(e: unknown): boolean {
  return e instanceof ApiProblem && e.status === 400;
}
