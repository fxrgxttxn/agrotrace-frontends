import type { AltchaChallenge } from '@agrotrace/api-client/public';

// Solving an ALTCHA challenge in a worker (the page stays responsive on a slow phone). A worker that cannot start or
// whose file fails to load rejects — the form says the anti-spam check could not be prepared, and the next submit
// starts a new worker (its file is asked for again).

/** The `altcha` payload for a challenge; rejects when it cannot be solved. */
export function solveChallenge(c: AltchaChallenge): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./altcha.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e);
      return;
    }
    worker.onmessage = (e: MessageEvent<{ payload: string | null }>) => {
      worker.terminate();
      if (e.data.payload) resolve(e.data.payload);
      else reject(new Error('ALTCHA challenge has no solution'));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      reject(new Error('ALTCHA worker failed'));
    };
    worker.postMessage(c);
  });
}

/** When the challenge expires (`?expires=<unix seconds>` in the salt), in ms; null when the salt does not say. */
export function expiresAt(c: AltchaChallenge): number | null {
  const m = /[?&]expires=(\d+)/.exec(c.salt);
  return m ? Number(m[1]) * 1000 : null;
}
