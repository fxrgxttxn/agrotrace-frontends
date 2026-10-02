import { untrack } from 'svelte';
import { page } from '$app/state';
import { ApiProblem } from '@agrotrace/api-client';
import { formatSort, parseSort, type SortState } from '../ui/table';
import { goto } from './goto';

// Table state lives in the URL (spec §9.3): `page`, `sort` (`field,dir`, as x-sort) and the screen's filters. Any
// filter or sort change starts again from page 1; pagination links keep every other parameter (README «Пагинация»).
// A URL is typed or pasted by people (ruling F11): parameters the screen does not accept — a sort field outside
// x-sort, an unknown enum value, a malformed date or id, a page that is not a positive integer — are dropped from the
// URL (replace) and never sent, so a bad link does not end in a 400. The same rules as the React app
// (src/app/listState.ts there). A change of the list's parameters is a query-only navigation: the focus stays where it
// is (ruling FM7, `keepFocus`).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Longest search text of the contract (`Q`: maxLength 100, in code points). */
const TEXT_MAX = 100;

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
  const pageNo = params.get('page');
  if (pageNo !== null && /^[1-9]\d{0,6}$/.test(pageNo) && pageNo !== '1') out.set('page', pageNo);
  const sort = parseSort(params.get('sort'));
  if (sort && spec.sort.includes(sort.field)) out.set('sort', formatSort(sort));
  for (const [key, allowed] of Object.entries(spec.enums ?? {}))
    // Local dedup of this pass, not component state.
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
  // `q`: 1–100 code points in the contract (Q parameter); a longer text is cut, not sent to a certain 400.
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
  /** A single-valued parameter (`''` when absent). */
  get: (key: string) => string;
  /** Sets (or, for `null` / `''` / `[]`, removes) parameters and goes back to page 1. */
  set: (patch: Record<string, string | string[] | null | undefined>) => void;
  setSort: (next: SortState) => void;
  hrefFor: (page: number) => string;
  /** Removes every list parameter (search, filters, sort, page); the focus goes to the page title (ruling F12). */
  reset: () => void;
  /** A page past the end (a list that shrank, an old link): go to the last page instead of an empty one. */
  clampPage: (total: number, size: number) => void;
}

/** The list state of the screen at `path` (call during component initialisation). */
export function listParams(path: () => string, spec: ListSpec): ListParams {
  const here = () => page.url.pathname === path();
  const params = $derived(sanitizeParams(page.url.searchParams, spec));
  const pageNo = $derived(Math.max(1, Number(params.get('page')) || 1));
  const sort = $derived(parseSort(params.get('sort')));

  const go = (q: URLSearchParams, replaceState = false) =>
    void goto(withQuery(path(), q), { keepFocus: true, noScroll: true, replaceState });

  // Parameters the list does not accept leave the URL (replace) — never while the router is on another page.
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
      // The «Сбросить фильтры» button goes away with the filters: the focus goes to the page title (ruling F12).
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

/** An empty page of a non-empty list: `pastEnd` — past the last page (go to the last one); `changed` — a page inside
 * the list came back empty (the list changed between the count and the rows): the screen offers a reload, never an
 * endless loading. `null` — nothing odd. */
export function listGap(
  data: { items: readonly unknown[]; total: number },
  pageNo: number,
  size: number,
): 'pastEnd' | 'changed' | null {
  if (data.items.length > 0 || data.total === 0) return null;
  return pageNo > Math.max(1, Math.ceil(data.total / size)) ? 'pastEnd' : 'changed';
}

/** A list request the server rejected as invalid (400): the screen offers «Сбросить фильтры». */
export function isBadListQuery(e: unknown): boolean {
  return e instanceof ApiProblem && e.status === 400;
}
