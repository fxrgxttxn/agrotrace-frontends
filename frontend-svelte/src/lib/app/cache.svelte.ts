import { onDestroy, untrack } from 'svelte';
import { ApiProblem } from '@agrotrace/api-client';

// Server data (spec §9.2 for Svelte: `.svelte.ts` modules with `$state` and their own request cache). Ruling FM21 — one
// data-loading policy for every screen, the same as the React app's QueryClient (src/app/providers.tsx there):
//   - a GET is retried up to 2 times (≈1 s, then 2 s) unless the answer is a 4xx (429 included: its wait is the
//     server's);
//   - an answer stays fresh 30 s (dictionaries / regions: until the page is reloaded) — a screen opened again within
//     that time shows it at once without asking;
//   - requests of the same key in flight are shared;
//   - on a changed key (tab / page / filter) the previous rows stay on screen while the new ones load; if that load
//     fails they are dropped and the failed state with «Повторить» shows (the screen disables its bulk actions);
//   - a failed refetch of the same key keeps the rows it had;
//   - `invalidate(prefix)` (a live event, the result of a change) refetches the screens showing such a key.
// The cache belongs to the session: `clear()` when it ends (logout, loss, another tab).

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

interface Watcher {
  key(): string | null;
  refetch(): Promise<void>;
}

class Cache {
  /** Delays before the retries of a failed GET (ms). */
  retryDelays: readonly number[] = [1000, 2000];
  #entries = new Map<string, { data: unknown; at: number }>();
  #inflight = new Map<string, Promise<unknown>>();
  #watchers = new Set<Watcher>();
  /** Bumped by `clear`: answers of requests started before are not stored. */
  #generation = 0;

  /** The cached answer of `key` if it is still fresh for `freshMs`. */
  peek<T>(key: Key, freshMs = FRESH_MS): T | undefined {
    const e = this.#entries.get(keyOf(key));
    return e && Date.now() - e.at < freshMs ? (e.data as T) : undefined;
  }

  /** Loads `key` (retrying as FM21 says), sharing a request already in flight; stores the answer. */
  fetch<T>(key: Key, load: () => Promise<T>): Promise<T> {
    const k = keyOf(key);
    const running = this.#inflight.get(k);
    if (running) return running as Promise<T>;
    const generation = this.#generation;
    const run = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await load();
          if (generation === this.#generation) this.#entries.set(k, { data, at: Date.now() });
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
    run.then(done, done);
    return run;
  }

  /** Stores an answer the app got otherwise (the result of a change). */
  set(key: Key, data: unknown): void {
    this.#entries.set(keyOf(key), { data, at: Date.now() });
  }

  /** Forgets every answer under `prefix` and refetches the screens that show one. */
  invalidate(prefix: Key): Promise<void> {
    for (const k of [...this.#entries.keys()]) if (under(k, prefix)) this.#entries.delete(k);
    // a request started before the change may answer with the old state: the refetch asks anew
    for (const k of [...this.#inflight.keys()]) if (under(k, prefix)) this.#inflight.delete(k);
    const runs: Promise<void>[] = [];
    for (const w of this.#watchers) {
      const k = w.key();
      if (k !== null && under(k, prefix)) runs.push(w.refetch());
    }
    return Promise.all(runs).then(() => undefined);
  }

  /** Forgets everything (the session ended). */
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

export interface QueryOptions {
  /** How long an answer stays fresh (default {@link FRESH_MS}; {@link FOREVER} for dictionaries). */
  freshMs?: number;
  /** Asks again every so many ms while it returns a number (e.g. while a Telegram link code is out). */
  refetchInterval?: () => number | false;
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
  readonly #load: (key: Key) => Promise<T>;
  readonly #freshMs: number;

  constructor(load: (key: Key) => Promise<T>, freshMs: number) {
    this.#load = load;
    this.#freshMs = freshMs;
  }

  /** The key changed (or the query started): its fresh answer at once, or a load. */
  show(key: Key | null): void {
    this.#currentKey = key;
    this.#current = key === null ? null : keyOf(key);
    if (key === null) return;
    const fresh = cache.peek<T>(key, this.#freshMs);
    if (fresh !== undefined) {
      this.data = fresh;
      this.#shown = this.#current;
      this.failed = false;
      this.fetching = false;
      return;
    }
    this.failed = false;
    void this.#run();
  }

  /** Asks the server again (after an action, a live event, «Повторить»). */
  refetch = (): Promise<void> => this.#run();

  /** Shows (and caches) an answer the screen got otherwise — e.g. the result of a PUT. */
  set(value: T): void {
    if (this.#currentKey) cache.set(this.#currentKey, value);
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
    this.fetching = true;
    try {
      const answer = await cache.fetch(key, () => this.#load(key));
      if (!this.#alive || k !== this.#current) return;
      this.data = answer;
      this.#shown = k;
      this.failed = false;
    } catch {
      if (!this.#alive || k !== this.#current) return;
      // rows of another key are never shown as this key's (FM21); rows of this key survive a failed refetch
      if (this.#shown !== k) this.data = null;
      this.failed = this.data === null;
    } finally {
      if (this.#alive && k === this.#current) this.fetching = false;
    }
  }
}

/** A query for a component (call it during initialisation): `key` is read reactively — a new key shows its fresh
 * answer at once or loads it; `null` — nothing to load yet. `load` fetches a key. */
export function query<T>(
  key: () => Key | null,
  load: (key: Key) => Promise<T>,
  options: QueryOptions = {},
): Query<T> {
  const q = new Query<T>(load, options.freshMs ?? FRESH_MS);
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
    const timer = setInterval(() => void q.refetch(), every);
    return () => clearInterval(timer);
  });
  return q;
}
