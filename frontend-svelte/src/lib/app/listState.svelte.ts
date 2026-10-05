import { untrack } from 'svelte';
import { page } from '$app/state';
import { ApiProblem } from '@agrotrace/api-client';
import { formatSort, parseSort, type SortState } from '../ui/table';
import { goto } from './goto';

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
  const pageNo = params.get('page');
  if (pageNo !== null && /^[1-9]\d{0,6}$/.test(pageNo) && pageNo !== '1') out.set('page', pageNo);
  const sort = parseSort(params.get('sort'));
  if (sort && spec.sort.includes(sort.field)) out.set('sort', formatSort(sort));
  for (const [key, allowed] of Object.entries(spec.enums ?? {}))
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
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

const canon = (p: URLSearchParams) =>
  [...p]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('&');

const withQuery = (path: string, q: URLSearchParams) => {
  const s = q.toString();
  return `${path}${s ? `?${s}` : ''}`;
};

export interface ListParams {
  readonly params: URLSearchParams;
  readonly page: number;
  readonly sort: SortState | null;
  get: (key: string) => string;
  set: (patch: Record<string, string | string[] | null | undefined>) => void;
  setSort: (next: SortState) => void;
  hrefFor: (page: number) => string;
  reset: () => void;
  clampPage: (total: number, size: number) => void;
}

export function listParams(path: () => string, spec: ListSpec): ListParams {
  const here = () => page.url.pathname === path();
  const params = $derived(sanitizeParams(page.url.searchParams, spec));
  const pageNo = $derived(Math.max(1, Number(params.get('page')) || 1));
  const sort = $derived(parseSort(params.get('sort')));

  const go = (q: URLSearchParams, replaceState = false) =>
    void goto(withQuery(path(), q), { keepFocus: true, noScroll: true, replaceState });

  $effect(() => {
    const clean = params;
    const raw = page.url.searchParams;
    if (canon(clean) === canon(raw)) return;
    untrack(() => {
      if (here()) go(clean, true);
    });
  });

  const set = (patch: Record<string, string | string[] | null | undefined>) => {
    const next = new URLSearchParams(page.url.searchParams);
    for (const [k, v] of Object.entries(patch)) {
      next.delete(k);
      if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
      else if (v !== null && v !== undefined && v !== '') next.set(k, v);
    }
    next.delete('page');
    go(next);
  };

  return {
    get params() {
      return params;
    },
    get page() {
      return pageNo;
    },
    get sort() {
      return sort;
    },
    get: (key) => params.get(key) ?? '',
    set,
    setSort: (next) => set({ sort: formatSort(next) }),
    hrefFor: (p) => {
      const q = new URLSearchParams(params);
      if (p > 1) q.set('page', String(p));
      else q.delete('page');
      return withQuery(path(), q);
    },
    reset: () => {
      const own = ownKeys(spec);
      const keep = new URLSearchParams();
      for (const [k, v] of page.url.searchParams) if (!own.has(k)) keep.append(k, v);
      go(keep);
      document.querySelector<HTMLElement>('h1.at-page__title')?.focus({ preventScroll: true });
    },
    clampPage: (total, size) => {
      const last = Math.max(1, Math.ceil(total / size));
      if (pageNo <= last || !here()) return;
      const next = new URLSearchParams(page.url.searchParams);
      if (last > 1) next.set('page', String(last));
      else next.delete('page');
      go(next, true);
    },
  };
}

export function listGap(
  data: { items: readonly unknown[]; total: number },
  pageNo: number,
  size: number,
): 'pastEnd' | 'changed' | null {
  if (data.items.length > 0 || data.total === 0) return null;
  return pageNo > Math.max(1, Math.ceil(data.total / size)) ? 'pastEnd' : 'changed';
}

export function isBadListQuery(e: unknown): boolean {
  return e instanceof ApiProblem && e.status === 400;
}

export const ALL = 'all';
export function collapseAll(path: () => string): void {
  $effect(() => {
    const statuses = page.url.searchParams.getAll('status');
    if (!statuses.includes(ALL) || statuses.length < 2) return;
    untrack(() => {
      if (page.url.pathname !== path()) return;
      const next = new URLSearchParams(page.url.searchParams);
      next.delete('status');
      next.append('status', ALL);
      void goto(withQuery(path(), next), { keepFocus: true, noScroll: true, replaceState: true });
    });
  });
}
