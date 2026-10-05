import { ApiProblem, newIdempotencyKey } from '@agrotrace/api-client';
import { retryAfterOf } from './api';

const IN_PROGRESS_REPEATS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type IdempotentRun = <T>(
  request: unknown,
  send: (key: string) => Promise<T>,
  scope?: string,
) => Promise<T>;

export function idempotency(): IdempotentRun {
  const kept = new Map<string, { key: string; request: string }>();
  return async <T>(request: unknown, send: (key: string) => Promise<T>, scope = ''): Promise<T> => {
    const fingerprint = JSON.stringify(request ?? null);
    let slot = kept.get(scope);
    if (!slot || slot.request !== fingerprint) {
      slot = { key: newIdempotencyKey(), request: fingerprint };
      kept.set(scope, slot);
    }
    const { key } = slot;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await send(key);
        kept.delete(scope);
        return result;
      } catch (e) {
        const inProgress = e instanceof ApiProblem && e.code === 'IDEMPOTENCY_KEY_IN_PROGRESS';
        if (inProgress && attempt < IN_PROGRESS_REPEATS) {
          await sleep(Math.min(retryAfterOf(e), 5) * 1000);
          continue;
        }
        if (e instanceof ApiProblem && e.status < 500 && e.status !== 429 && !inProgress) kept.delete(scope);
        throw e;
      }
    }
  };
}
