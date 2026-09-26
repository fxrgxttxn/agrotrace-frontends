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
import { ToastService } from './ui/toasts';

// Rulings FM21 / FM24 — one data-loading policy for every screen, the same as the React app's QueryClient:
//   - a GET is retried up to 2 times (≈1 s, then 2 s) unless the answer is a 4xx; a retry re-requests exactly what the
//     query started with (its params are captured when it starts, never read again);
//   - an answer is fresh 30 s (dictionaries / regions: until the page is reloaded): a screen opened again within that
//     time shows it at once without asking; an older answer is shown (aria-busy) while it is asked for again
//     (stale-while-revalidate) and kept, with the screen's failed toast, when that refetch fails;
//   - requests of the same key in flight are shared;
//   - on a changed key (tab / page / filter) with nothing cached, the previous rows stay while the new ones load; if
//     that load fails they are dropped and the failed state with «Повторить» shows (bulk actions disabled);
//   - the cache belongs to the session: it is emptied when the session ends, and every write — answers and results of
//     changes alike — carries the session generation it started in: a write of an ended session is dropped (a slow
//     answer for user A never lands in user B's cache).

/** Fresh time of an answer (ms). */
export const FRESH_MS = 30_000;
/** Until the page is reloaded (dictionaries, regions). */
export const FOREVER = Number.POSITIVE_INFINITY;

/** Key prefix of the notification lists (a live notification makes them all stale, app-wide — FM24). */
export const NOTIFICATIONS_KEY = 'notifications?';

/** Delays before the retries of a failed GET (ms). */
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
  private gen = 0;
  /** Keys invalidated while their request was in flight. */
  private readonly staleOnArrival = new Set<string>();

  constructor() {
    const sub = inject(SessionService).ended$.subscribe(() => this.clear());
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  /** The session generation now (take it when a request starts, give it to {@link put}). */
  get generation(): number {
    return this.gen;
  }

  /** The cached answer of `key` and whether it is still fresh for `freshMs`. */
  read<T>(key: string, freshMs: number): { data: T; fresh: boolean } | undefined {
    const e = this.entries.get(key);
    return e ? { data: e.data as T, fresh: Date.now() - e.at < freshMs } : undefined;
  }

  /** The cached answer of `key` if it is still fresh. */
  peek<T>(key: string, freshMs: number): T | undefined {
    const e = this.read<T>(key, freshMs);
    return e?.fresh ? e.data : undefined;
  }

  /** Loads `key` with `load` (the request as it was started — a retry repeats it), sharing a request already in
   * flight; stores the answer unless the session ended meanwhile. No request is made for an ended session (FM25: the
   * generation is checked again after every backoff sleep). */
  fetch<T>(key: string, load: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const generation = this.gen;
    const self: { run?: Promise<unknown> } = {};
    const run = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await load();
          // only this run's own mark (a run of an ended generation never clears a newer run's mark)
          const stale = this.inflight.get(key) === self.run && this.staleOnArrival.delete(key);
          if (this.put(key, data, generation) && stale) this.entries.get(key)!.at = Number.NEGATIVE_INFINITY;
          return data;
        } catch (e) {
          const delay = this.delays[attempt];
          if (delay === undefined || !retriable(e) || generation !== this.gen) throw e;
          await new Promise((r) => setTimeout(r, delay));
          if (generation !== this.gen) throw e;
        }
      }
    })();
    self.run = run;
    this.inflight.set(key, run);
    const done = () => {
      if (this.inflight.get(key) === run) {
        this.inflight.delete(key);
        this.staleOnArrival.delete(key);
      }
    };
    run.then(done, done);
    return run;
  }

  /** Stores an answer taken in session `generation` (dropped when that session has ended). */
  put(key: string, data: unknown, generation: number): boolean {
    if (generation !== this.gen) return false;
    this.entries.set(key, { data, at: Date.now() });
    return true;
  }

  /** Marks every key starting with `prefix` stale: its rows stay for the next read, which asks the server. A request
   * of such a key in flight answers stale (FM25: it may predate what made the key stale). */
  invalidate(prefix: string): void {
    for (const [k, e] of this.entries) if (k.startsWith(prefix)) e.at = Number.NEGATIVE_INFINITY;
    for (const k of this.inflight.keys()) if (k.startsWith(prefix)) this.staleOnArrival.add(k);
  }

  clear(): void {
    this.gen++;
    this.entries.clear();
    this.inflight.clear();
    this.staleOnArrival.clear();
  }
}

/** What a query asks for now: its cache key and the request with the params of this moment captured. */
export interface QuerySpec<T> {
  key: string;
  load: () => Promise<T>;
}

export interface Query<T> {
  /** The rows on screen: the answer of the current key, or the previous key's while the new one loads. */
  readonly data: Signal<T | null>;
  /** The last load of the current key failed and there is nothing of this key to show. */
  readonly failed: Signal<boolean>;
  /** A request is running (the rows on screen may be stale: `aria-busy`). */
  readonly fetching: Signal<boolean>;
  /** A writer for the result of a change, bound to the session and key of this moment — call it when the change
   * starts, use it when it answers (a result of an ended session is dropped). */
  writer(): (value: T) => void;
  /** Asks the server again (after an action, a live event, «Повторить»). */
  refetch(): Promise<void>;
}

export interface QueryOptions {
  /** How long an answer stays fresh (default {@link FRESH_MS}; {@link FOREVER} for dictionaries). */
  freshMs?: number;
  /** The screen's failed text: a toast when a refetch fails while its (stale) rows stay on screen. */
  failedText?: string;
}

/** A query for a screen (create it in an injection context). `spec` is read in a reactive context: a new key shows the
 * cache (fresh — no request; stale — shown while asked for again) or loads. */
export function injectQuery<T>(spec: () => QuerySpec<T>, options: QueryOptions = {}): Query<T> {
  const cache = inject(QueryCache);
  const toasts = inject(ToastService);
  const freshMs = options.freshMs ?? FRESH_MS;
  const data = signal<T | null>(null);
  const failed = signal(false);
  const fetching = signal(false);
  /** Key whose answer `data` holds (`null`: nothing, or the previous key's rows as a placeholder). */
  let shownKey: string | null = null;
  let current: QuerySpec<T> = { key: '', load: () => Promise.reject(new Error('no query yet')) };
  let alive = true;
  let toast: number | null = null;
  const dropToast = () => {
    if (toast !== null) toasts.dismiss(toast);
    toast = null;
  };
  inject(DestroyRef).onDestroy(() => {
    alive = false;
    dropToast();
  });

  const run = async (s: QuerySpec<T>): Promise<void> => {
    let again = false;
    fetching.set(true);
    try {
      const answer = await cache.fetch(s.key, s.load);
      if (!alive || s !== current) return;
      data.set(answer);
      shownKey = s.key;
      failed.set(false);
      dropToast();
      // invalidated while it was on its way (FM25): shown, and asked for again at once — the screen is on
      again = cache.read(s.key, freshMs)?.fresh === false;
    } catch {
      if (!alive || s !== current) return;
      if (shownKey === s.key) {
        // stale rows of this key stay; the failure is said (FM24)
        if (options.failedText) {
          dropToast();
          toast = toasts.push({ tone: 'danger', text: options.failedText });
        }
      } else {
        // rows of another key are never shown as this key's (FM21)
        data.set(null);
      }
      failed.set(data() === null);
    } finally {
      if (alive && s === current) fetching.set(false);
    }
    if (again) await run(s);
  };

  effect(
    () => {
      const s = spec();
      untracked(() => {
        current = s;
        failed.set(false);
        const cached = cache.read<T>(s.key, freshMs);
        if (cached) {
          data.set(cached.data);
          shownKey = s.key;
          if (cached.fresh) {
            fetching.set(false);
            return;
          }
        }
        void run(s);
      });
    },
    { allowSignalWrites: true },
  );

  return {
    data: data.asReadonly(),
    failed: failed.asReadonly(),
    fetching: fetching.asReadonly(),
    writer: () => {
      const s = current;
      const generation = cache.generation;
      return (value: T) => {
        if (!cache.put(s.key, value, generation) || !alive || s !== current) return;
        data.set(value);
        shownKey = s.key;
        failed.set(false);
      };
    },
    refetch: () => {
      cache.invalidate(current.key);
      return run(current);
    },
  };
}
