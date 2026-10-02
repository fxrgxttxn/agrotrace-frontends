import { onDestroy, untrack } from 'svelte';
import { ApiProblem } from '@agrotrace/api-client';
import { passive } from './focusRescue';
import { t } from './i18n';
import { toasts } from '../ui/toast-store.svelte';

// Server data (spec §9.2 for Svelte: `.svelte.ts` modules with `$state` and their own request cache). Rulings FM21,
// FM24–FM27 — one data-loading policy for every screen, the same as the React app's QueryClient:
//   - a GET is retried up to 2 times (≈1 s, then 2 s) unless the answer is a 4xx (429 included: its wait is the
//     server's); after each backoff sleep the session is checked again — no request after the session ended;
//   - an answer stays fresh 30 s (dictionaries / regions: until the page is reloaded) — a screen opened again within
//     that time shows it at once without asking; an older answer is shown too (busy) while it is asked again
//     (stale-while-revalidate), and kept if that fails, with the screen's «… не загрузились.» toast;
//   - requests of the same key in flight are shared; a retry always asks for the key it started with;
//   - on a changed key (tab / page / filter) the previous rows stay on screen while the new ones load; if that load
//     fails they are dropped and the failed state with «Повторить» shows (the screen disables its bulk actions);
//   - `invalidate(prefix)` (a live event, the result of a change) refetches the screens showing such a key; a fetch
//     already on its way began before the change, so its answer is not stored as fresh;
//   - the cache belongs to one signed-in person: `clear()` when a session starts or ends bumps the generation, and a
//     write started in an earlier generation (a late answer of the previous person) is dropped.

export type Key = readonly (string | number | boolean | null)[];

/** Fresh time of an answer (ms). */
export const FRESH_MS = 30_000;
/** Until the page is reloaded (dictionaries, regions). */
export const FOREVER = Number.POSITIVE_INFINITY;

const keyOf = (key: Key) => JSON.stringify(key);

/** Whether the key string `k` lies under `prefix` (`['notifications']` covers `['notifications','all',1]`). */
function under(k: string, prefix: Key): boolean {
  const head = keyOf(prefix).slice(0, -1);
  return k === `${head}]` || k.startsWith(`${head},`);
}

/** A 4xx is an answer, not a failure to retry. */
function retriable(e: unknown): boolean {
  return !(e instanceof ApiProblem && e.status >= 400 && e.status < 500);
}

/** The session this request belonged to has ended (thrown instead of a late retry). */
export class SessionEnded extends Error {
  constructor() {
    super('session ended');
  }
}

interface Watcher {
  key(): string | null;
  refetch(passive?: boolean): Promise<void>;
}

interface Run {
  promise: Promise<unknown>;
  /** Invalidated while on its way: its answer is not stored as fresh. */
  stale: boolean;
}

class Cache {
  /** Delays before the retries of a failed GET (ms). */
  retryDelays: readonly number[] = [1000, 2000];
  #entries = new Map<string, { data: unknown; at: number }>();
  #inflight = new Map<string, Run>();
  #watchers = new Set<Watcher>();
  #generation = 0;

  /** The session generation: bumped whenever a session starts or ends. */
  get generation(): number {
    return this.#generation;
  }

  /** The cached answer of `key` if it is still fresh for `freshMs`. */
  peek<T>(key: Key, freshMs = FRESH_MS): T | undefined {
    const e = this.#entries.get(keyOf(key));
    return e && Date.now() - e.at < freshMs ? (e.data as T) : undefined;
  }

  /** The cached answer of `key`, fresh or not (`fresh` says which). */
  entry<T>(key: Key, freshMs = FRESH_MS): { data: T; fresh: boolean } | undefined {
    const e = this.#entries.get(keyOf(key));
    return e && { data: e.data as T, fresh: Date.now() - e.at < freshMs };
  }

  /** Loads `key` (retrying as FM21 says), sharing a request already in flight; stores the answer. */
  fetch<T>(key: Key, load: () => Promise<T>): Promise<T> {
    const k = keyOf(key);
    const running = this.#inflight.get(k);
    if (running) return running.promise as Promise<T>;
    const generation = this.#generation;
    const run: Run = { promise: Promise.resolve(), stale: false };
    run.promise = (async () => {
      for (let attempt = 0; ; attempt++) {
        if (generation !== this.#generation) throw new SessionEnded();
        try {
          const data = await load();
          if (generation === this.#generation && !run.stale) this.#entries.set(k, { data, at: Date.now() });
          return data;
        } catch (e) {
          const delay = this.retryDelays[attempt];
          if (delay === undefined || !retriable(e)) throw e;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    })();
    this.#inflight.set(k, run);
    const done = () => {
      if (this.#inflight.get(k) === run) this.#inflight.delete(k);
    };
    run.promise.then(done, done);
    return run.promise as Promise<T>;
  }

  /** Stores an answer the app got otherwise (the result of a change) — only in the session it was asked in. */
  set(key: Key, data: unknown, generation: number): boolean {
    if (generation !== this.#generation) return false;
    this.#entries.set(keyOf(key), { data, at: Date.now() });
    return true;
  }

  /** Forgets every answer under `prefix` and refetches the screens that show one; answers on their way are stale. */
  invalidate(prefix: Key, o: { passive?: boolean } = {}): Promise<void> {
    for (const k of [...this.#entries.keys()]) if (under(k, prefix)) this.#entries.delete(k);
    for (const [k, run] of [...this.#inflight])
      if (under(k, prefix)) {
        run.stale = true;
        this.#inflight.delete(k);
      }
    const runs: Promise<void>[] = [];
    for (const w of this.#watchers) {
      const k = w.key();
      if (k !== null && under(k, prefix)) runs.push(w.refetch(o.passive));
    }
    return Promise.all(runs).then(() => undefined);
  }

  /** Forgets everything: a session started or ended (the previous person's late writes and retries are dropped). */
  clear(): void {
    this.#generation += 1;
    this.#entries.clear();
    this.#inflight.clear();
  }

  watch(w: Watcher): () => void {
    this.#watchers.add(w);
    return () => this.#watchers.delete(w);
  }
}

export const cache = new Cache();

/** Ruling FM26: whether the component (a screen, a card) is still mounted and its session still lasts. After an
 * `await`, the UI steps of an action — toast, navigation, focus, form message, bell — run only while this is true: a
 * late answer after the person left or signed out is silent. Call during component initialisation. */
export function screenAlive(): () => boolean {
  const born = cache.generation;
  let mounted = true;
  onDestroy(() => (mounted = false));
  return () => mounted && cache.generation === born;
}

export interface QueryOptions {
  /** How long an answer stays fresh (default {@link FRESH_MS}; {@link FOREVER} for dictionaries). */
  freshMs?: number;
  /** Asks again every so many ms while it returns a number (e.g. while a Telegram link code is out). */
  refetchInterval?: () => number | false;
  /** i18n key of the screen's «… не загрузились.» text: the toast of a failed refetch of rows on screen (FM24). */
  failed?: string;
}

/** A query of a screen: `data` (the answer of the current key, or the previous key's while the new one loads),
 * `failed` (the last load of the current key failed and there is nothing of it to show), `fetching`. */
export class Query<T> {
  data = $state<T | null>(null);
  failed = $state(false);
  fetching = $state(false);
  #current: string | null = null;
  #currentKey: Key | null = null;
  /** Key whose answer `data` holds (`null`: nothing, or the previous key's rows as a placeholder). */
  #shown: string | null = null;
  #alive = true;
  /** Number of the latest request: an older one that answers later never overwrites it. */
  #seq = 0;
  readonly #load: (key: Key) => Promise<T>;
  readonly #options: QueryOptions;

  constructor(load: (key: Key) => Promise<T>, options: QueryOptions) {
    this.#load = load;
    this.#options = options;
  }

  /** The key changed (or the query started): its fresh answer at once, or a load (an old answer shown meanwhile). */
  show(key: Key | null): void {
    this.#currentKey = key;
    this.#current = key === null ? null : keyOf(key);
    if (key === null) return;
    const cached = cache.entry<T>(key, this.#options.freshMs ?? FRESH_MS);
    this.failed = false;
    if (cached) {
      this.data = cached.data;
      this.#shown = this.#current;
      if (cached.fresh) {
        this.#seq += 1; // an older request of another key never overwrites these rows
        this.fetching = false;
        return;
      }
    }
    void this.#run();
  }

  /** Asks the server again (after an action, a live event, «Повторить»). */
  refetch = (passiveRun = false): Promise<void> => (passiveRun ? passive(() => this.#run()) : this.#run());

  /** Shows (and caches) an answer the screen got otherwise — e.g. the result of a PUT — in the session it was asked
   * in (`generation`, captured before the request): a late answer of an ended session is dropped. */
  set(value: T, generation: number): void {
    if (!this.#currentKey || !cache.set(this.#currentKey, value, generation)) return;
    if (!this.#alive) return;
    this.data = value;
    this.#shown = this.#current;
    this.failed = false;
  }

  /** The current key (cache invalidation). */
  key = (): string | null => this.#current;

  stop(): void {
    this.#alive = false;
  }

  async #run(): Promise<void> {
    const key = this.#currentKey;
    const k = this.#current;
    if (key === null || k === null) return;
    const seq = ++this.#seq;
    const generation = cache.generation;
    const mine = () => this.#alive && seq === this.#seq && generation === cache.generation;
    this.fetching = true;
    try {
      // the key the request was started for: its retries ask for the same one (FM24)
      const answer = await cache.fetch(key, () => this.#load(key));
      if (!mine()) return;
      this.data = answer;
      this.#shown = k;
      this.failed = false;
    } catch (e) {
      if (!mine() || e instanceof SessionEnded) return;
      // rows of another key are never shown as this key's (FM21); rows of this key survive a failed refetch — with
      // the screen's failed toast (FM24)
      if (this.#shown !== k) this.data = null;
      this.failed = this.data === null;
      if (!this.failed && this.#options.failed)
        toasts.push({
          tone: e instanceof ApiProblem && e.status === 429 ? 'attention' : 'danger',
          text: t(this.#options.failed),
        });
    } finally {
      if (seq === this.#seq && this.#alive) this.fetching = false;
    }
  }
}

/** A query for a component (call it during initialisation): `key` is read reactively — a new key shows its fresh
 * answer at once or loads it; `null` — nothing to load yet. `load` fetches the key it is given (never the screen's
 * current state: a retry asks for the key it started with). */
export function query<T>(
  key: () => Key | null,
  load: (key: Key) => Promise<T>,
  options: QueryOptions = {},
): Query<T> {
  const q = new Query<T>(load, options);
  const unwatch = cache.watch(q);
  onDestroy(() => {
    q.stop();
    unwatch();
  });
  let last: string | null | undefined;
  $effect.pre(() => {
    const next = key();
    const k = next === null ? null : keyOf(next);
    if (k === last) return;
    last = k;
    untrack(() => q.show(next));
  });
  $effect(() => {
    const every = options.refetchInterval?.();
    if (!every) return;
    const timer = setInterval(() => void q.refetch(true), every);
    return () => clearInterval(timer);
  });
  return q;
}
