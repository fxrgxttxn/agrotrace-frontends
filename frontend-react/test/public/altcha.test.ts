import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256hex } from '../../src/public/sha256';
import { altchaPayload, answer, solvePow } from '../../src/public/pow';
import { expiresAt, solveChallenge } from '../../src/public/altcha';
import { challengeFor, installWorker } from './worker';

const node = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

afterEach(() => vi.unstubAllGlobals());

describe('sha256', () => {
  it.each(['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'Жалоба ✓', 'x'.repeat(1000)])(
    'equals node crypto for %j',
    (s) => expect(sha256hex(s)).toBe(node(s)),
  );
});

describe('proof of work', () => {
  it('finds the number and builds the verifiable payload', () => {
    const c = challengeFor(737);
    expect(solvePow(c)).toBe(737);
    const decoded = JSON.parse(atob(altchaPayload(c, 737, 12)));
    expect(decoded).toEqual({
      algorithm: 'SHA-256',
      challenge: c.challenge,
      number: 737,
      salt: c.salt,
      signature: c.signature,
      took: 12,
    });
    expect(node(decoded.salt + decoded.number)).toBe(decoded.challenge);
    expect(JSON.parse(atob(answer(c, () => 0)!)).number).toBe(737);
  });

  it('an unsolvable challenge gives null; the expiry comes from the salt', () => {
    expect(answer({ ...challengeFor(5, 100), challenge: '0'.repeat(64) })).toBeNull();
    expect(expiresAt(challengeFor(1))).toBe(4102444800 * 1000);
    expect(expiresAt({ ...challengeFor(1), salt: 'nosalt' })).toBeNull();
  });

  it('the payload verifies with the mock backend (the reference solver)', async () => {
    const { solveChallenge: reference } = await import('@agrotrace/mock-api');
    const c = challengeFor(99, 500);
    expect(JSON.parse(atob(answer(c)!))).toMatchObject(JSON.parse(atob(reference(c))));
  });
});

describe('solveChallenge (worker)', () => {
  it('posts the challenge to the worker and resolves its payload', async () => {
    const workers = installWorker();
    const c = challengeFor(4321, 5000);
    expect(JSON.parse(atob(await solveChallenge(c))).number).toBe(4321);
    expect(workers[0]!.url).toMatch(/altcha\.worker/);
    expect(workers[0]!.terminated).toBe(true);
  });

  it('rejects when the challenge has no solution, when the worker file fails, when no worker can start', async () => {
    installWorker();
    await expect(solveChallenge({ ...challengeFor(1, 50), challenge: '0'.repeat(64) })).rejects.toThrow();
    installWorker('fail');
    await expect(solveChallenge(challengeFor(1))).rejects.toThrow(/worker/);
    vi.stubGlobal('Worker', undefined);
    await expect(solveChallenge(challengeFor(1))).rejects.toThrow();
  });
});
