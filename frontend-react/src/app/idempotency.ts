import { useCallback, useRef } from 'react';
import { ApiProblem, newIdempotencyKey } from '@agrotrace/api-client';
import { retryAfterOf } from './api';

// Idempotent operations (BR-11, contract parameter Idempotency-Key): one key per intended operation — a form or an
// action button keeps its key while the answer is not definite (a network failure, a 5xx, a 429, the first request still
// running) and the request is the same, so a repeat is never a duplicate. A changed request (the form was edited after
// the failure — ruling FM13) gets a new key, and so does everything after a definite answer (2xx, any other 4xx).
// IDEMPOTENCY_KEY_REUSED (the key met another request) drops the key too; its text asks to send again (FM13).
// While the first request with the key is still running the server answers 409 IDEMPOTENCY_KEY_IN_PROGRESS with
// `Retry-After: 1`: the client waits it out and repeats by itself (a few times) instead of showing an error.

const IN_PROGRESS_REPEATS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `scope` — one kept key per intended operation of a screen with several (a task list: each task keeps its own key, so
 * switching to another task and back repeats the first one with its key). */
export type IdempotentRun = <T>(
  request: unknown,
  send: (key: string) => Promise<T>,
  scope?: string,
) => Promise<T>;

/** Keeps the key of this form or button between the attempts of one request (`request` — what is sent). */
export function useIdempotency(): IdempotentRun {
  const kept = useRef(new Map<string, { key: string; request: string }>());
  return useCallback(
    async <T>(request: unknown, send: (key: string) => Promise<T>, scope = ''): Promise<T> => {
      const fingerprint = JSON.stringify(request ?? null);
      let slot = kept.current.get(scope);
      if (!slot || slot.request !== fingerprint) {
        slot = { key: newIdempotencyKey(), request: fingerprint };
        kept.current.set(scope, slot);
      }
      const { key } = slot;
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await send(key);
          kept.current.delete(scope);
          return result;
        } catch (e) {
          const inProgress = e instanceof ApiProblem && e.code === 'IDEMPOTENCY_KEY_IN_PROGRESS';
          if (inProgress && attempt < IN_PROGRESS_REPEATS) {
            await sleep(Math.min(retryAfterOf(e), 5) * 1000);
            continue;
          }
          if (e instanceof ApiProblem && e.status < 500 && e.status !== 429 && !inProgress)
            kept.current.delete(scope);
          throw e;
        }
      }
    },
    [],
  );
}
