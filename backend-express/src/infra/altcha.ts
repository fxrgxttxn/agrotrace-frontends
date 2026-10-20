/**
 * ALTCHA proof of work for the public complaint form (contract getCaptchaChallenge / createPublicComplaint; the
 * format of altcha-lib / altcha / altcha-org/altcha v1), shared by the three backends so a challenge issued by one is
 * accepted by any:
 *
 *   key       = hex(HMAC-SHA256(JWT_SECRET, "agrotrace:altcha:v1"))  (used as the HMAC key string, UTF-8)
 *   salt      = 24 hex chars + "?expires=" + Unix seconds (issue time + 600)
 *   challenge = sha256hex(salt + number), number ∈ [0, maxnumber] secret
 *   signature = hex(HMAC-SHA256(key, challenge))
 *
 * A solution (`altcha` field) is base64 of JSON {algorithm: "SHA-256", challenge, number, salt, signature, …}; it is
 * valid when it parses, `expires` in the salt is not in the past, sha256hex(salt + number) = challenge and the
 * signature matches; the byte-exact rules (canonical padded base64, `number` as plain decimal digits, lowercase
 * hex, `expires` required) are in the contract, the shared test vector in contracts/rules/altcha.json. Replay
 * protection (`altcha-used:{signature}`) is the caller's (shared Redis, R82).
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const ALTCHA_TTL_SEC = 600;
export const ALTCHA_MAX_NUMBER = 100_000;

export interface AltchaChallenge {
  algorithm: 'SHA-256';
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmacHex = (key: string, msg: string) => createHmac('sha256', key).update(msg, 'utf8').digest('hex');

export const altchaKey = (jwtSecret: string): string =>
  createHmac('sha256', jwtSecret).update('agrotrace:altcha:v1').digest('hex');

export function createAltchaChallenge(key: string, nowMs = Date.now()): AltchaChallenge {
  const expires = Math.floor(nowMs / 1000) + ALTCHA_TTL_SEC;
  const salt = `${randomBytes(12).toString('hex')}?expires=${expires}`;
  const challenge = sha256hex(salt + randomInt(0, ALTCHA_MAX_NUMBER + 1));
  return {
    algorithm: 'SHA-256',
    challenge,
    salt,
    signature: hmacHex(key, challenge),
    maxnumber: ALTCHA_MAX_NUMBER,
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The signature of a valid, unexpired solution (its replay key), or null. */
export function verifyAltchaSolution(key: string, payload: string, nowMs = Date.now()): string | null {
  let v: Record<string, unknown>;
  // Source texts of `number` members per holder object (JSON.parse reviver context, Node 22).
  const numberSource = new Map<object, string | undefined>();
  try {
    // Standard base64 (RFC 4648 §4) with padding, canonical: no URL-safe alphabet, no whitespace, no missing `=`.
    if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.toString('base64') !== payload) return null;
    const reviver = function (this: object, k: string, value: unknown, ctx?: { source?: string }) {
      if (k === 'number') numberSource.set(this, ctx?.source);
      return value;
    };
    const parsed: unknown = JSON.parse(bytes.toString('utf8'), reviver as (k: string, v: unknown) => unknown);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    v = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const { algorithm, challenge, number, salt, signature } = v;
  if (algorithm !== 'SHA-256' || typeof salt !== 'string' || typeof challenge !== 'string') return null;
  if (typeof signature !== 'string' || !HEX64.test(signature) || !HEX64.test(challenge)) return null;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) return null;
  // `number` is written as plain decimal digits (no sign, fraction, exponent or leading zero).
  if (!/^(0|[1-9][0-9]*)$/.test(numberSource.get(v) ?? '')) return null;
  const m = /[?&]expires=(\d{1,12})(?:&|$)/.exec(salt);
  if (!m || Number(m[1]) * 1000 < nowMs) return null;
  if (sha256hex(salt + String(number)) !== challenge) return null;
  const expected = Buffer.from(hmacHex(key, challenge), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return null;
  return signature;
}
