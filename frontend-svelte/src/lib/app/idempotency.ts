import { ApiProblem, newIdempotencyKey } from '@agrotrace/api-client';
import { retryAfterOf } from './api.svelte';

// Idempotent operations (BR-11, contract parameter Idempotency-Key): one key per intended operation — a form or an
// action button keeps its key while the answer is not definite (a network failure, a 5xx, a 429, the first request
// still running) and the request is the same, so a repeat is never a duplicate. A changed request (the form was
// edited after the failure — ruling FM13) gets a new key, and so does everything after a definite answer (2xx, any
// other 4xx). IDEMPOTENCY_KEY_REUSED (the key met another request) drops the key too; its text asks to send again
// (FM13). While the first request with the key is still running the server answers 409
// IDEMPOTENCY_KEY_IN_PROGRESS with `Retry-After: 1`: the client waits it out and repeats by itself (a few times)
// instead of showing an error. As the React app's `useIdempotency` (src/app/idempotency.ts there).

const IN_PROGRESS_REPEATS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keeps the key of a form or action button between the attempts of one request (call during component
 * initialisation; one instance per screen with several kept intents — `run`'s `scope` tells them apart). */
export class Idempotency {
  #kept = new Map<string, { key: string; request: string }>();

  /** `request` — what is sent (its JSON fingerprint decides whether this is the same intent as the kept key);
   * `send` gets the key to use; `scope` — which kept intent (default: the only one). */
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
