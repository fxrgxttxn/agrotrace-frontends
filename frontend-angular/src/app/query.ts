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
import { Subject } from 'rxjs';
import { ApiProblem } from '@agrotrace/api-client';
import { SessionService } from './session';
import { ToastService } from './ui/toasts';

export const FRESH_MS = 30_000;
export const FOREVER = Number.POSITIVE_INFINITY;

export const NOTIFICATIONS_KEY = 'notifications?';

export const RETRY_DELAYS = new InjectionToken<readonly number[]>('RETRY_DELAYS', {
  providedIn: 'root',
  factory: () => [1000, 2000],
});

function retriable(e: unknown): boolean {
  return !(e instanceof ApiProblem && e.status >= 400 && e.status < 500);
}

@Injectable({ providedIn: 'root' })
export class QueryCache {
  private readonly delays = inject(RETRY_DELAYS);
  private readonly entries = new Map<string, { data: unknown; at: number }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private gen = 0;
  readonly live$ = new Subject<string>();
  private readonly staleOnArrival = new Set<string>();

  constructor() {
    const sub = inject(SessionService).ended$.subscribe(() => this.clear());
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  get generation(): number {
    return this.gen;
  }

  read<T>(key: string, freshMs: number): { data: T; fresh: boolean } | undefined {
    const e = this.entries.get(key);
    return e ? { data: e.data as T, fresh: Date.now() - e.at < freshMs } : undefined;
  }

  peek<T>(key: string, freshMs: number): T | undefined {
    const e = this.read<T>(key, freshMs);
    return e?.fresh ? e.data : undefined;
  }

  fetch<T>(key: string, load: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const generation = this.gen;
    const self: { run?: Promise<unknown> } = {};
    const run = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await load();
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

  put(key: string, data: unknown, generation: number): boolean {
    if (generation !== this.gen) return false;
    this.entries.set(key, { data, at: Date.now() });
    return true;
  }

  invalidate(prefix: string): void {
    for (const [k, e] of this.entries) if (k.startsWith(prefix)) e.at = Number.NEGATIVE_INFINITY;
    for (const k of this.inflight.keys()) if (k.startsWith(prefix)) this.staleOnArrival.add(k);
  }

  remove(key: string): void {
    this.entries.delete(key);
  }

  refresh(prefix: string): void {
    this.invalidate(prefix);
    this.live$.next(prefix);
  }

  clear(): void {
    this.gen++;
    this.entries.clear();
    this.inflight.clear();
    this.staleOnArrival.clear();
  }
}

export interface QuerySpec<T> {
  key: string;
  load: () => Promise<T>;
}

export interface Query<T> {
  readonly data: Signal<T | null>;
  readonly failed: Signal<boolean>;
  readonly error: Signal<unknown>;
  readonly fetching: Signal<boolean>;
  writer(): (value: T) => void;
  refetch(): Promise<void>;
}

export interface QueryOptions {
  freshMs?: number;
  failedText?: string;
}

export function injectQuery<T>(spec: () => QuerySpec<T> | null, options: QueryOptions = {}): Query<T> {
  const cache = inject(QueryCache);
  const toasts = inject(ToastService);
  const freshMs = options.freshMs ?? FRESH_MS;
  const data = signal<T | null>(null);
  const failed = signal(false);
  const error = signal<unknown>(null);
  const fetching = signal(false);
  let shownKey: string | null = null;
  let current: QuerySpec<T> = { key: '', load: () => Promise.reject(new Error('no query yet')) };
  let alive = true;
  let toast: number | null = null;
  const dropToast = () => {
    if (toast !== null) toasts.dismiss(toast);
    toast = null;
  };
  const liveSub = cache.live$.subscribe((prefix) => {
    if (alive && current.key !== '' && current.key.startsWith(prefix)) void run(current);
  });
  inject(DestroyRef).onDestroy(() => {
    alive = false;
    liveSub.unsubscribe();
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
      error.set(null);
      again = cache.read(s.key, freshMs)?.fresh === false;
    } catch (e) {
      if (!alive || s !== current) return;
      error.set(e);
      if (shownKey === s.key) {
        if (options.failedText) {
          dropToast();
          toast = toasts.push({ tone: 'danger', text: options.failedText });
        }
      } else {
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
      const next = spec();
      untracked(() => {
        if (next === null) {
          current = { key: '', load: () => Promise.reject(new Error('no query')) };
          shownKey = null;
          data.set(null);
          failed.set(false);
          error.set(null);
          fetching.set(false);
          return;
        }
        const s = next;
        current = s;
        failed.set(false);
        error.set(null);
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
    error: error.asReadonly(),
    fetching: fetching.asReadonly(),
    writer: () => {
      const s = current;
      const generation = cache.generation;
      return (value: T) => {
        if (!cache.put(s.key, value, generation) || !alive || s !== current) return;
        data.set(value);
        shownKey = s.key;
        failed.set(false);
        error.set(null);
      };
    },
    refetch: () => {
      if (current.key === '') return Promise.resolve();
      cache.invalidate(current.key);
      return run(current);
    },
  };
}
