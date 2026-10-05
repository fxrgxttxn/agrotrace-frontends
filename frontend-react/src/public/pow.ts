import { sha256hex } from './sha256';

export interface Challenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

export function solvePow(c: Challenge, from = 0, to = c.maxnumber): number | null {
  for (let n = from; n <= to; n++) if (sha256hex(c.salt + n) === c.challenge) return n;
  return null;
}

export function altchaPayload(c: Challenge, number: number, took: number): string {
  const { algorithm, challenge, salt, signature } = c;
  return btoa(JSON.stringify({ algorithm, challenge, number, salt, signature, took }));
}

export function answer(c: Challenge, now: () => number = () => performance.now()): string | null {
  const started = now();
  const n = solvePow(c);
  return n === null ? null : altchaPayload(c, n, Math.round(now() - started));
}
