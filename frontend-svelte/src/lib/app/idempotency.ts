import { ApiProblem, newIdempotencyKey } from '@agrotrace/api-client';
import { retryAfterOf } from './api.svelte';

const IN_PROGRESS_REPEATS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Idempotency {
  #kept = new Map<string, { key: string; request: string }>();

  async run<T>(request: unknown, send: (key: string) => Promise<T>, scope = ''): Promise<T> {
    const fingerprint = JSON.stringify(request ?? null);
    let slot = this.#kept.get(scope);
    if (!slot || slot.request !== fingerprint) {
      slot = { key: newIdempotencyKey(), request: fingerprint };
      this.#kept.set(scope, slot);
    }
    const { key } = slot;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await send(key);
        this.#kept.delete(scope);
        return result;
      } catch (e) {
        const inProgress = e instanceof ApiProblem && e.code === 'IDEMPOTENCY_KEY_IN_PROGRESS';
        if (inProgress && attempt < IN_PROGRESS_REPEATS) {
          await sleep(Math.min(retryAfterOf(e), 5) * 1000);
          continue;
        }
        if (e instanceof ApiProblem && e.status < 500 && e.status !== 429 && !inProgress)
          this.#kept.delete(scope);
        throw e;
      }
    }
  }
}
