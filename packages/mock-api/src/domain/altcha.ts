import { hex, hmacSha256, randomBytes, sha256hex, toBase64 } from '../lib/crypto.js';

export const ALTCHA_MAX_NUMBER = 50_000;
const TTL_SEC = 600;

export interface AltchaChallenge {
  algorithm: 'SHA-256';
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

export function createChallenge(secret: string, nowMs: number): AltchaChallenge {
  const expires = Math.floor(nowMs / 1000) + TTL_SEC;
  const salt = `${hex(randomBytes(12))}?expires=${expires}`;
  const number = new DataView(randomBytes(4).buffer).getUint32(0) % (ALTCHA_MAX_NUMBER + 1);
  const challenge = sha256hex(salt + number);
  return { algorithm: 'SHA-256', challenge, salt, signature: hex(hmacSha256(`${secret}:altcha`, challenge)), maxnumber: ALTCHA_MAX_NUMBER };
}

export function solveChallenge(c: AltchaChallenge): string {
  for (let n = 0; n <= c.maxnumber; n++)
    if (sha256hex(c.salt + n) === c.challenge)
      return toBase64(new TextEncoder().encode(JSON.stringify({ algorithm: c.algorithm, challenge: c.challenge, number: n, salt: c.salt, signature: c.signature })));
  throw new Error('unsolvable challenge');
}

export function verifySolution(secret: string, payload: string, nowMs: number): string | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))) as Record<string, unknown>;
    if (v.algorithm !== 'SHA-256' || typeof v.salt !== 'string' || typeof v.challenge !== 'string' || typeof v.signature !== 'string')
      return null;
    if (typeof v.number !== 'number' || !Number.isInteger(v.number)) return null;
    const expires = Number(/[?&]expires=(\d+)/.exec(v.salt)?.[1]);
    if (!Number.isFinite(expires) || expires * 1000 < nowMs) return null;
    if (sha256hex(v.salt + v.number) !== v.challenge) return null;
    if (hex(hmacSha256(`${secret}:altcha`, v.challenge)) !== v.signature) return null;
    return v.signature;
  } catch {
    return null;
  }
}
