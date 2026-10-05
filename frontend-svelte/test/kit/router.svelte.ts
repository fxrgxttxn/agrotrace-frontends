import { tick, type Component } from 'svelte';
import { isRedirect } from '@sveltejs/kit';
import { page } from './state.svelte';

type Loader = (event: LoadEvent) => unknown;
interface LoadEvent {
  url: URL;
  params: Record<string, string>;
  route: { id: string };
  parent: () => Promise<Record<string, unknown>>;
  fetch: typeof fetch;
  depends: () => void;
  untrack: <T>(fn: () => T) => T;
  data: null;
  setHeaders: () => void;
}
interface TsModule {
  load?: Loader;
}
interface SvelteModule {
  default: Component<Record<string, unknown>>;
}

const tsModules = import.meta.glob<TsModule>('/src/routes/**/+{page,layout}.ts', { eager: true });
const svelteModules = import.meta.glob<SvelteModule>('/src/routes/**/+{page,layout}.svelte', { eager: true });

interface Level {
  dir: string;
  ts?: TsModule;
  component?: SvelteModule['default'];
}

interface RouteDef {
  id: string;
  segments: string[];
  levels: Level[];
  page: Level;
}

const dirOf = (file: string) => file.replace(/^\/src\/routes/, '').replace(/\/\+[^/]+$/, '') || '';

function buildRoutes(): RouteDef[] {
  const pageDirs = Object.keys(svelteModules)
    .filter((f) => f.endsWith('/+page.svelte'))
    .map(dirOf);
  return pageDirs.map((dir) => {
    const parts = dir.split('/').filter(Boolean);
    const levels: Level[] = [];
    for (let i = 0; i <= parts.length; i++) {
      const d = parts.slice(0, i).length ? `/${parts.slice(0, i).join('/')}` : '';
      const ts = tsModules[`/src/routes${d}/+layout.ts`];
      const svelte = svelteModules[`/src/routes${d}/+layout.svelte`];
      if (ts || svelte) levels.push({ dir: d, ts, component: svelte?.default });
    }
    return {
      id: dir || '/',
      segments: parts.filter((p) => !/^\(.*\)$/.test(p)),
      levels,
      page: {
        dir,
        ts: tsModules[`/src/routes${dir}/+page.ts`],
        component: svelteModules[`/src/routes${dir}/+page.svelte`]!.default,
      },
    };
  });
}

const ROUTES = buildRoutes();

function match(route: RouteDef, path: string): Record<string, string> | null {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params: Record<string, string> = {};
  let i = 0;
  for (let s = 0; s < route.segments.length; s++) {
    const seg = route.segments[s]!;
    const rest = /^\[\.\.\.(\w+)\]$/.exec(seg);
    if (rest) {
      const tailLen = route.segments.length - s - 1;
      const take = parts.length - i - tailLen;
      if (take < 0) return null;
      params[rest[1]!] = parts.slice(i, i + take).join('/');
      i += take;
      continue;
    }
    const part = parts[i];
    if (part === undefined) return null;
    const param = /^\[(\w+)\]$/.exec(seg);
    if (param) params[param[1]!] = part;
    else if (seg !== part) return null;
    i += 1;
  }
  return i === parts.length ? params : null;
}

function rank(route: RouteDef): number[] {
  return route.segments.map((s) => (s.startsWith('[...') ? 2 : s.startsWith('[') ? 1 : 0));
}

function compare(a: RouteDef, b: RouteDef): number {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const d = (ra[i] ?? -1) - (rb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

const SORTED = [...ROUTES].sort(compare);

export interface ChainNode {
  component: SvelteModule['default'];
  data: Record<string, unknown>;
}

type NavType = 'enter' | 'goto' | 'link' | 'popstate';
export interface Navigation {
  from: { url: URL; params: Record<string, string>; route: { id: string | null } } | null;
  to: { url: URL; params: Record<string, string>; route: { id: string | null } } | null;
  type: NavType;
  willUnload: false;
  complete: Promise<void>;
}

class TestRouter {
  chain = $state.raw<ChainNode[]>([]);
  afterNavigate = new Set<(nav: Navigation) => void>();
  #history: { url: string; state: Record<string, unknown> }[] = [];
  #index = -1;
  #started = false;
  #token = 0;

  reset(): void {
    this.chain = [];
    this.afterNavigate.clear();
    this.#history = [];
    this.#index = -1;
    this.#started = false;
    this.#token += 1;
  }

  get routes(): readonly RouteDef[] {
    return ROUTES;
  }

  async start(path: string): Promise<void> {
    await this.#navigate(path, { replace: true, type: 'enter' });
  }

  async goto(
    path: string,
    opts: { replaceState?: boolean; state?: Record<string, unknown>; keepFocus?: boolean } = {},
  ): Promise<void> {
    await this.#navigate(path, {
      replace: Boolean(opts.replaceState),
      type: 'goto',
      state: opts.state,
      keepFocus: Boolean(opts.keepFocus),
    });
  }

  async back(): Promise<void> {
    if (this.#index <= 0) return;
    this.#index -= 1;
    const entry = this.#history[this.#index]!;
    await this.#navigate(entry.url, { type: 'popstate', pop: true, state: entry.state });
  }

  async forward(): Promise<void> {
    if (this.#index >= this.#history.length - 1) return;
    this.#index += 1;
    const entry = this.#history[this.#index]!;
    await this.#navigate(entry.url, { type: 'popstate', pop: true, state: entry.state });
  }

  onClick = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a[href]');
    if (!(a instanceof HTMLAnchorElement) || a.target || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
    e.preventDefault();
    const keeper = a.closest('[data-sveltekit-keepfocus]');
    const keepFocus = Boolean(keeper) && keeper!.getAttribute('data-sveltekit-keepfocus') !== 'false';
    void this.#navigate(url.pathname + url.search + url.hash, { type: 'link', keepFocus });
  };

  async #navigate(
    target: string,
    o: {
      replace?: boolean;
      type: NavType;
      state?: Record<string, unknown>;
      pop?: boolean;
      keepFocus?: boolean;
    },
    hops = 0,
  ): Promise<void> {
    if (hops > 10) throw new Error(`redirect loop at ${target}`);
    const token = ++this.#token;
    const url = new URL(target, 'http://localhost/');
    const route = SORTED.find((r) => match(r, url.pathname));
    if (!route) throw new Error(`no route for ${url.pathname} (the app has a catch-all)`);
    const params = match(route, url.pathname)!;
    const loaded: Record<string, unknown>[] = [];
    try {
      for (const level of [...route.levels, route.page]) {
        const parentData = loaded.reduce<Record<string, unknown>>((acc, d) => ({ ...acc, ...d }), {});
        const data = (await level.ts?.load?.({
          url,
          params,
          route: { id: route.id },
          parent: async () => parentData,
          fetch,
          depends: () => {},
          untrack: (fn) => fn(),
          data: null,
          setHeaders: () => {},
        })) as Record<string, unknown> | undefined;
        loaded.push(data ?? {});
      }
    } catch (e) {
      if (isRedirect(e)) {
        if (token !== this.#token) return;
        return this.#navigate(e.location, { ...o, replace: o.replace || o.pop, pop: false }, hops + 1);
      }
      throw e;
    }
    if (token !== this.#token) return;

    if (
      !o.keepFocus &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
    )
      document.activeElement.blur();
    const from = this.#started ? { url: page.url, params: page.params, route: { id: page.route.id } } : null;
    const state = o.state ?? {};
    if (!o.pop) {
      if (o.replace && this.#index >= 0) this.#history[this.#index] = { url: url.href, state };
      else {
        this.#history = this.#history.slice(0, this.#index + 1);
        this.#history.push({ url: url.href, state });
        this.#index += 1;
      }
    }
    history.replaceState({ 'sveltekit:history': this.#index }, '', url.pathname + url.search + url.hash);

    let merged: Record<string, unknown> = {};
    const chain: ChainNode[] = [];
    [...route.levels, route.page].forEach((level, i) => {
      merged = { ...merged, ...loaded[i] };
      if (level.component) chain.push({ component: level.component, data: merged });
    });
    page.url = url;
    page.params = params;
    page.route = { id: route.id };
    page.state = state;
    page.data = merged;
    this.chain = chain;
    const type: NavType = this.#started ? o.type : 'enter';
    this.#started = true;
    await tick();
    await tick();
    const nav: Navigation = {
      from,
      to: { url, params, route: { id: route.id } },
      type,
      willUnload: false,
      complete: Promise.resolve(),
    };
    for (const fn of [...this.afterNavigate]) fn(nav);
  }
}

export const router = new TestRouter();
