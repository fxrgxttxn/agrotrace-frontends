import { sha256hex } from './sha256';

// The ALTCHA proof of work (contract AltchaChallenge, FR-PUB-03): find n in [0, maxnumber] with
// sha256(salt + n) = challenge; the answer is the base64 JSON payload the ALTCHA server libraries verify. Runs in the
// worker (altcha.worker.ts) only: the page's own chunk carries no SHA-256.

export interface Challenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

/** The number in `[from, to]` that solves the challenge, or null. */
export function solvePow(c: Challenge, from = 0, to = c.maxnumber): number | null {
  for (let n = from; n <= to; n++) if (sha256hex(c.salt + n) === c.challenge) return n;
  return null;
}

/** The `altcha` field of the complaint: base64 of {algorithm, challenge, number, salt, signature, took}. */
export function altchaPayload(c: Challenge, number: number, took: number): string {
  const { algorithm, challenge, salt, signature } = c;
  return btoa(JSON.stringify({ algorithm, challenge, number, salt, signature, took }));
}

/** The worker's answer to a challenge: the payload, or null when nothing in range solves it. */
export function answer(c: Challenge, now: () => number = () => performance.now()): string | null {
  const started = now();
  const n = solvePow(c);
  return n === null ? null : altchaPayload(c, n, Math.round(now() - started));
}
