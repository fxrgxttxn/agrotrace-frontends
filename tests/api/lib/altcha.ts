/**
 * ALTCHA proof of work as the contract fixes it (getCaptchaChallenge / createPublicComplaint): the HMAC key is
 * hex(HMAC-SHA256(JWT_SECRET, "agrotrace:altcha:v1")) — shared by the three backends, like the file-URL key — so a
 * challenge issued by one is accepted by another, and tests can forge correctly signed challenges (expired ones).
 *
 *   challenge = sha256hex(salt + number), number ∈ [0, maxnumber]; salt = "<hex>?expires=<unix seconds>";
 *   signature = hex(HMAC-SHA256(key, challenge)); the solution (`altcha` field) = base64(JSON {algorithm, challenge,
 *   number, salt, signature}).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { ApiClient } from './client.js';
import { expectContract } from './contract.js';

export interface AltchaChallenge {
  algorithm: 'SHA-256';
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export const altchaKey = (secret: string = process.env.JWT_SECRET!): string =>
  createHmac('sha256', secret).update('agrotrace:altcha:v1').digest('hex');

export const altchaSignature = (challenge: string, key: string = altchaKey()): string =>
  createHmac('sha256', key).update(challenge).digest('hex');

export function encodeSolution(v: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
}

/** Brute force, as the widget does. */
export function solve(c: AltchaChallenge): string {
  for (let n = 0; n <= c.maxnumber; n++)
    if (sha256hex(c.salt + n) === c.challenge)
      return encodeSolution({
        algorithm: c.algorithm,
        challenge: c.challenge,
        number: n,
        salt: c.salt,
        signature: c.signature,
      });
  throw new Error('unsolvable ALTCHA challenge');
}

/** A correctly signed solution made by the test itself (e.g. `expiresSec` in the past, or another `key`). */
export function forge(opts: { expiresSec: number; key?: string; number?: number }): string {
  const salt = `${randomBytes(12).toString('hex')}?expires=${opts.expiresSec}`;
  const number = opts.number ?? 42;
  const challenge = sha256hex(salt + number);
  return encodeSolution({
    algorithm: 'SHA-256',
    challenge,
    number,
    salt,
    signature: altchaSignature(challenge, opts.key),
  });
}

export async function challenge(client: ApiClient) {
  const res = await client.get('/public/captcha');
  await expectContract(res, 'getCaptchaChallenge');
  return res;
}

/** A fresh solved challenge from the backend. */
export async function solution(client: ApiClient): Promise<string> {
  const res = await challenge(client);
  if (res.status !== 200) throw new Error(`getCaptchaChallenge: ${res.status} ${res.text}`);
  return solve(res.body as AltchaChallenge);
}
