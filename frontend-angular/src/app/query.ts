import {
  DestroyRef,
  effect,
  inject,
  Injectable,
  InjectionToken,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { ApiProblem } from '@agrotrace/api-client';
import { SessionService } from './session';

// Ruling FM21 — one data-loading policy for every screen, the same as the React app's QueryClient:
//   - a GET is retried up to 2 times (≈1 s, then 2 s) unless the answer is a 4xx;
//   - an answer stays fresh 30 s (dictionaries / regions: until the page is reloaded) — a screen opened again within
//     that time shows it at once without asking;
//   - requests of the same key in flight are shared;
//   - on a changed key (tab / page / filter) the previous rows stay on screen while the new ones load; if that load
//     fails they are dropped and the failed state with «Повторить» shows (bulk actions disabled by the screen);
//   - a failed refetch of the same key keeps the rows it had.
// The cache belongs to the session: it is emptied when the session ends (logout, loss, another tab).

/** Fresh time of an answer (ms). */
export const FRESH_MS = 30_000;
/** Until the page is reloaded (dictionaries, regions). */
export const FOREVER = Number.POSITIVE_INFINITY;

/** Delays before the retries of a failed GET (ms); tests may shorten them. */
export const RETRY_DELAYS = new InjectionToken<readonly number[]>('RETRY_DELAYS', {
  providedIn: 'root',
  factory: () => [1000, 2000],
});

/** A 4xx is an answer, not a failure to retry (429 included: its wait is the server's). */
function retriable(e: unknown): boolean {
  return !(e instanceof ApiProblem && e.status >= 400 && e.status < 500);
}

@Injectable({ providedIn: 'root' })
export class QueryCache {
  private readonly delays = inject(RETRY_DELAYS);
  private readonly entries = new Map<string, { data: unknown; at: number }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Bumped when the cache is emptied (answers of requests started before are not stored). */
  private generation = 0;

  constructor() {
    const sub = inject(SessionService).ended$.subscribe(() => this.clear());
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  /** The cached answer of `key` if it is still fresh for `freshMs`. */
  peek<T>(key: string, freshMs: number): T | undefined {
    const e = this.entries.get(key);
    return e && Date.now() - e.at < freshMs ? (e.data as T) : undefined;
  }

  /** Loads `key` (retrying as FM21 says), sharing a request already in flight; stores the answer. */
  fetch<T>(key: string, load: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const generation = this.generation;
    const run = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await load();
          if (generation === this.generation) this.entries.set(key, { data, at: Date.now() });
          return data;
        } catch (e) {
          const delay = this.delays[attempt];
          if (delay === undefined || !retriable(e)) throw e;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    })();
    this.inflight.set(key, run);
    const done = () => {
      if (this.inflight.get(key) === run) this.inflight.delete(key);
    };
    run.then(done, done);
    return run;
  }

  /** Stores an answer the app got otherwise (the result of a change). */
  put(key: string, data: unknown): void {
    this.entries.set(key, { data, at: Date.now() });
  }

  /** Marks every key starting with `prefix` stale (the next read asks the server). */
  invalidate(prefix: string): void {
    for (const k of this.entries.keys()) if (k.startsWith(prefix)) this.entries.delete(k);
  }

  clear(): void {
    this.generation++;
    this.entries.clear();
    this.inflight.clear();
  }
}

export interface Query<T> {
  /** The rows on screen: the answer of the current key, or the previous key's while the new one loads. */
  readonly data: Signal<T | null>;
  /** The last load of the current key failed (and there is nothing of this key to show). */
  readonly failed: Signal<boolean>;
  /** A request is running. */
  readonly fetching: Signal<boolean>;
  /** Shows (and caches) an answer the screen got otherwise — e.g. the result of a PUT. */
  set(value: T): void;
  /** Asks the server again (after an action, a live event, «Повторить»). */
  refetch(): Promise<void>;
}

export interface QueryOptions {
  /** How long an answer stays fresh (default {@link FRESH_MS}; {@link FOREVER} for dictionaries). */
  freshMs?: number;
}

/** A query for a screen (create it in an injection context): `key` is read in a reactive context — a new key loads
 * (from the fresh cache at once, or from the server); `load` fetches the current key. */
export function injectQuery<T>(
  key: () => string,
  load: () => Promise<T>,
  options: QueryOptions = {},
): Query<T> {
  const cache = inject(QueryCache);
  const freshMs = options.freshMs ?? FRESH_MS;
  const data = signal<T | null>(null);
  const failed = signal(false);
  const fetching = signal(false);
  /** Key whose answer `data` holds (`null`: nothing, or the previous key's rows as a placeholder). */
  let shownKey: string | null = null;
  let current = '';
  let alive = true;
  inject(DestroyRef).onDestroy(() => (alive = false));

  const run = async (k: string, force: boolean): Promise<void> => {
    if (force) cache.invalidate(k);
    fetching.set(true);
    try {
      const answer = await cache.fetch(k, load);
      if (!alive || k !== current) return;
      data.set(answer);
      shownKey = k;
      failed.set(false);
    } catch {
      if (!alive || k !== current) return;
      // rows of another key are never shown as this key's (FM21); rows of this key survive a failed refetch
      if (shownKey !== k) data.set(null);
      failed.set(data() === null);
    } finally {
      if (alive && k === current) fetching.set(false);
    }
  };

  effect(
    () => {
      const k = key();
      untracked(() => {
        current = k;
        const fresh = cache.peek<T>(k, freshMs);
        if (fresh !== undefined) {
          data.set(fresh);
          shownKey = k;
          failed.set(false);
          fetching.set(false);
          return;
        }
        failed.set(false);
        void run(k, false);
      });
    },
    { allowSignalWrites: true },
  );

  return {
    data: data.asReadonly(),
    failed: failed.asReadonly(),
    fetching: fetching.asReadonly(),
    set: (value: T) => {
      cache.put(current, value);
      data.set(value);
      shownKey = current;
      failed.set(false);
    },
    refetch: () => run(current, true),
  };
}
