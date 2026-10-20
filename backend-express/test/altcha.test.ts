/**
 * ALTCHA (contract getCaptchaChallenge / createPublicComplaint, P40): the shared vector contracts/rules/altcha.json —
 * the key derived from its jwtSecret, its challenge and signature, and the verdict of every case at its nowMs — so the
 * three backends verify solutions byte for byte alike. A freshly issued challenge is solvable and verifies.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { altchaKey, createAltchaChallenge, verifyAltchaSolution } from '../src/infra/altcha.js';

interface Vector {
  jwtSecret: string;
  key: string;
  salt: string;
  number: number;
  challenge: string;
  signature: string;
  cases: { name: string; payload: string; nowMs: number; valid: boolean }[];
}
const vector = JSON.parse(
  readFileSync(new URL('../../contracts/rules/altcha.json', import.meta.url), 'utf8'),
) as Vector;

describe('ALTCHA shared vector', () => {
  it('derives the key from JWT_SECRET', () => {
    expect(altchaKey(vector.jwtSecret)).toBe(vector.key);
  });
  for (const c of vector.cases)
    it(`${c.name} → ${c.valid ? 'valid' : 'invalid'}`, () => {
      const sig = verifyAltchaSolution(vector.key, c.payload, c.nowMs);
      expect(sig).toBe(c.valid ? vector.signature : null);
    });
});

describe('ALTCHA issue', () => {
  it('a new challenge expires in 600 s and its solution verifies once solved', () => {
    const key = altchaKey('x'.repeat(40));
    const now = Date.UTC(2026, 9, 21, 12);
    const c = createAltchaChallenge(key, now);
    const [rand, query] = c.salt.split('?');
    expect(rand).toMatch(/^[0-9a-f]{24}$/);
    expect(query).toBe(`expires=${now / 1000 + 600}`);
    let n = 0;
    while (
      createHash('sha256')
        .update(c.salt + n)
        .digest('hex') !== c.challenge
    )
      n++;
    expect(n).toBeLessThanOrEqual(c.maxnumber);
    const payload = Buffer.from(JSON.stringify({ ...c, number: n })).toString('base64');
    expect(verifyAltchaSolution(key, payload, now)).toBe(c.signature);
    expect(verifyAltchaSolution(key, payload, now + 600_001)).toBeNull();
  });
});
