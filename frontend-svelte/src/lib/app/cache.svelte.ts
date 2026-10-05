import { onDestroy, untrack } from 'svelte';
import { ApiProblem } from '@agrotrace/api-client';
import { passive } from './focusRescue';
import { t } from './i18n';
import { toasts } from '../ui/toast-store.svelte';

export type Key = readonly (string | number | boolean | null)[];

export const FRESH_MS = 30_000;
export const FOREVER = Number.POSITIVE_INFINITY;

const keyOf = (key: Key) => JSON.stringify(key);

function under(k: string, prefix: Key): boolean {
  const head = keyOf(prefix).slice(0, -1);
  return k === `${head}]` || k.startsWith(`${head},`);
}

function retriable(e: unknown): boolean {
  return !(e instanceof ApiProblem && e.status >= 400 && e.status < 500);
}

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
  stale: boolean;
}

class Cache {
  retryDelays: readonly number[] = [1000, 2000];
  #entries = new Map<string, { data: unknown; at: number }>();
  #inflight = new Map<string, Run>();
  #watchers = new Set<Watcher>();
  #generation = 0;

  get generation(): number {
    return this.#generation;
  }

  peek<T>(key: Key, freshMs = FRESH_MS): T | undefined {
    const e = this.#entries.get(keyOf(key));
    return e && Date.now() - e.at < freshMs ? (e.data as T) : undefined;
  }

  entry<T>(key: Key, freshMs = FRESH_MS): { data: T; fresh: boolean } | undefined {
    const e = this.#entries.get(keyOf(key));
    return e && { data: e.data as T, fresh: Date.now() - e.at < freshMs };
  }

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

  set(key: Key, data: unknown, generation: number): boolean {
    if (generation !== this.#generation) return false;
    this.#entries.set(keyOf(key), { data, at: Date.now() });
    return true;
  }

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

  forget(prefix: Key): void {
    for (const k of [...this.#entries.keys()]) if (under(k, prefix)) this.#entries.delete(k);
    for (const [k, run] of [...this.#inflight])
      if (under(k, prefix)) {
        run.stale = true;
        this.#inflight.delete(k);
      }
  }

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

export function screenAlive(): () => boolean {
  const born = cache.generation;
  let mounted = true;
  onDestroy(() => (mounted = false));
  return () => mounted && cache.generation === born;
}

export interface QueryOptions {
  freshMs?: number;
  refetchInterval?: () => number | false;
  failed?: string;
}

export class Query<T> {
  data = $state<T | null>(null);
  failed = $state(false);
  fetching = $state(false);
  error = $state<unknown>(null);
  #current: string | null = null;
  #currentKey: Key | null = null;
  #shown: string | null = null;
  #alive = true;
  #seq = 0;
  readonly #load: (key: Key) => Promise<T>;
  readonly #options: QueryOptions;

  constructor(load: (key: Key) => Promise<T>, options: QueryOptions) {
    this.#load = load;
    this.#options = options;
  }

  show(key: Key | null): void {
    this.#currentKey = key;
    this.#current = key === null ? null : keyOf(key);
    if (key === null) return;
    const cached = cache.entry<T>(key, this.#options.freshMs ?? FRESH_MS);
    this.failed = false;
    this.error = null;
    if (cached) {
      this.data = cached.data;
      this.#shown = this.#current;
      if (cached.fresh) {
        this.#seq += 1;
        this.fetching = false;
        return;
      }
    }
    void this.#run();
  }

  refetch = (passiveRun = false): Promise<void> => (passiveRun ? passive(() => this.#run()) : this.#run());

  set(value: T, generation: number): void {
    if (!this.#currentKey || !cache.set(this.#currentKey, value, generation)) return;
    if (!this.#alive) return;
    this.data = value;
    this.#shown = this.#current;
    this.failed = false;
  }

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
      const answer = await cache.fetch(key, () => this.#load(key));
      if (!mine()) return;
      this.data = answer;
      this.#shown = k;
      this.failed = false;
      this.error = null;
    } catch (e) {
      if (!mine() || e instanceof SessionEnded) return;
      if (this.#shown !== k) this.data = null;
      this.failed = this.data === null;
      this.error = e;
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
