import type { AltchaChallenge } from '@agrotrace/api-client/public';

export function solveChallenge(c: AltchaChallenge): Promise<string> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./altcha.worker', import.meta.url), { type: 'module' });
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

export function expiresAt(c: AltchaChallenge): number | null {
  const m = /[?&]expires=(\d+)/.exec(c.salt);
  return m ? Number(m[1]) * 1000 : null;
}
