import { DestroyRef, inject, signal, type Signal } from '@angular/core';
import { ApiProblem, createPublicApi, retryAfterOf, type PublicBatch } from '@agrotrace/api-client/public';
import { takeEarly } from '../early';

export const api = createPublicApi({
  baseUrl: `${window.location.origin}/api/v1`,
  fetch: (input, init) => takeEarly(String(input)) ?? fetch(input, init),
});

export const PUBLIC_CODE = /^AT-\d{4}-\d{6,}$/;

export type Failure = { kind: 'offline' } | { kind: 'unavailable' } | { kind: 'limited'; wait: number };

export type BatchState =
  | { status: 'loading' }
  | { status: 'ok'; batch: PublicBatch }
  | { status: 'notFound' }
  | { status: 'failed'; failure: Failure; busy: boolean };

export function failureOf(e: unknown): Failure {
  if (e instanceof ApiProblem) {
    if (e.status === 429) return { kind: 'limited', wait: retryAfterOf(e) ?? 60 };
    return { kind: 'unavailable' };
  }
  return { kind: 'offline' };
}

const cache = new Map<string, PublicBatch>();

export function injectBatch(code: string): { state: Signal<BatchState>; retry: () => void } {
  const known = cache.get(code);
  const state = signal<BatchState>(
    known
      ? { status: 'ok', batch: known }
      : PUBLIC_CODE.test(code)
        ? { status: 'loading' }
        : { status: 'notFound' },
  );
  let ctl: AbortController | null = null;
  inject(DestroyRef).onDestroy(() => ctl?.abort());
  const load = () => {
    ctl?.abort();
    const mine = new AbortController();
    ctl = mine;
    state.update((s) => (s.status === 'failed' ? { ...s, busy: true } : { status: 'loading' }));
    api.getBatch(code, { signal: mine.signal }).then(
      (batch) => {
        cache.set(code, batch);
        if (!mine.signal.aborted) state.set({ status: 'ok', batch });
      },
      (e: unknown) => {
        if (mine.signal.aborted) return;
        if (e instanceof ApiProblem && (e.status === 404 || e.status === 400))
          state.set({ status: 'notFound' });
        else state.set({ status: 'failed', failure: failureOf(e), busy: false });
      },
    );
  };
  if (!known && PUBLIC_CODE.test(code)) load();
  return { state: state.asReadonly(), retry: load };
}

export function clearBatchCache(): void {
  cache.clear();
}
