import { useCallback, useRef } from 'react';
import { ApiProblem, newIdempotencyKey } from '@agrotrace/api-client';
import { retryAfterOf } from './api';

// Idempotent operations (BR-11, contract parameter Idempotency-Key): one key per intended operation — a form or an
// action button keeps its key while the answer is not definite (a network failure, a 5xx, a 429, the first request still
// running), so a repeat is the same request and never a duplicate. A definite answer (2xx, any other 4xx) ends the
// intent: the next submit gets a new key (the body may have changed). While the first request with the key is still
// running the server answers 409 IDEMPOTENCY_KEY_IN_PROGRESS with `Retry-After: 1`: the client waits it out and repeats
// by itself (a few times) instead of showing an error.

const IN_PROGRESS_REPEATS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keeps the key of this form or button between its attempts. */
export function useIdempotency(): <T>(send: (key: string) => Promise<T>) => Promise<T> {
  const key = useRef<string | null>(null);
  return useCallback(async <T>(send: (key: string) => Promise<T>): Promise<T> => {
    const current = (key.current ??= newIdempotencyKey());
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await send(current);
        key.current = null;
        return result;
      } catch (e) {
        const inProgress = e instanceof ApiProblem && e.code === 'IDEMPOTENCY_KEY_IN_PROGRESS';
        if (inProgress && attempt < IN_PROGRESS_REPEATS) {
          await sleep(Math.min(retryAfterOf(e), 5) * 1000);
          continue;
        }
        if (e instanceof ApiProblem && e.status < 500 && e.status !== 429 && !inProgress) key.current = null;
        throw e;
      }
    }
  }, []);
}
