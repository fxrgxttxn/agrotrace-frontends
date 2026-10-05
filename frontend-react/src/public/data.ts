import { useCallback, useEffect, useState } from 'react';
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

export function useBatch(code: string): { state: BatchState; retry: () => void } {
  const known = cache.get(code);
  const [state, setState] = useState<BatchState>(() =>
    known
      ? { status: 'ok', batch: known }
      : PUBLIC_CODE.test(code)
        ? { status: 'loading' }
        : { status: 'notFound' },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!PUBLIC_CODE.test(code)) {
      setState({ status: 'notFound' });
      return;
    }
    const cached = cache.get(code);
    if (cached && attempt === 0) {
      setState({ status: 'ok', batch: cached });
      return;
    }
    const ctl = new AbortController();
    setState((s) => (s.status === 'failed' ? { ...s, busy: true } : { status: 'loading' }));
    api.getBatch(code, { signal: ctl.signal }).then(
      (batch) => {
        cache.set(code, batch);
        setState({ status: 'ok', batch });
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        if (e instanceof ApiProblem && (e.status === 404 || e.status === 400))
          setState({ status: 'notFound' });
        else setState({ status: 'failed', failure: failureOf(e), busy: false });
      },
    );
    return () => ctl.abort();
  }, [code, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { state, retry };
}

export function clearBatchCache(): void {
  cache.clear();
}
