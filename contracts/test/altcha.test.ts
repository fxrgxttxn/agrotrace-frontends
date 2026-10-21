/**
 * The ALTCHA vector (rules/altcha.json, contract getCaptchaChallenge P40) is self-consistent under the contract's
 * recipe, recomputed here independently of any backend: key, challenge and signature, and the valid case decodes to the
 * stated fields.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const v = JSON.parse(readFileSync(new URL('../rules/altcha.json', import.meta.url), 'utf8'));
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (k: string, m: string) => createHmac('sha256', k).update(m, 'utf8').digest('hex');

describe('ALTCHA vector', () => {
  it('key, challenge and signature follow the recipe', () => {
    expect(v.key).toBe(hmac(v.jwtSecret, 'agrotrace:altcha:v1'));
    expect(v.challenge).toBe(sha(`${v.salt}${v.number}`));
    expect(v.signature).toBe(hmac(v.key, v.challenge));
  });
  it('the valid case is the standard base64 of the solution JSON', () => {
    const ok = v.cases.find((c: { name: string }) => c.name === 'valid solution');
    const json = JSON.parse(Buffer.from(ok.payload, 'base64').toString('utf8'));
    expect(json).toEqual({
      algorithm: 'SHA-256',
      challenge: v.challenge,
      number: v.number,
      salt: v.salt,
      signature: v.signature,
    });
    expect(ok.valid).toBe(true);
    expect(new Set(v.cases.map((c: { name: string }) => c.name)).size).toBe(v.cases.length);
  });
});
