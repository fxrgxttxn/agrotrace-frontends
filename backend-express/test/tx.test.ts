/** withTx (R47/R52): isolation level, one retry on 40P01/40001, then 409 VERSION_CONFLICT. */
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { withTx } from '../src/db/tx.js';
import { AppProblem } from '../src/http/problem.js';

/** A Kysely stand-in recording the isolation level of each transaction attempt. */
function fakeDb() {
  const levels: string[] = [];
  const db = {
    transaction: () => ({
      setIsolationLevel: (level: string) => ({
        execute: async <T>(fn: (tx: unknown) => Promise<T>) => {
          levels.push(level);
          return fn({ attempt: levels.length });
        },
      }),
    }),
  } as unknown as Kysely<unknown>;
  return { db, levels };
}

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('withTx', () => {
  it('runs once at READ COMMITTED by default and returns the result', async () => {
    const { db, levels } = fakeDb();
    await expect(withTx(db, async () => 42)).resolves.toBe(42);
    expect(levels).toEqual(['read committed']);
  });

  it('uses the requested isolation (recall engine: REPEATABLE READ)', async () => {
    const { db, levels } = fakeDb();
    await withTx(db, async () => null, { isolation: 'repeatable read' });
    expect(levels).toEqual(['repeatable read']);
  });

  for (const code of ['40P01', '40001']) {
    it(`retries the whole transaction once after ${code}`, async () => {
      const { db, levels } = fakeDb();
      let calls = 0;
      const out = await withTx(db, async () => {
        calls++;
        if (calls === 1) throw pgError(code);
        return 'second';
      });
      expect(out).toBe('second');
      expect(levels).toHaveLength(2);
    });

    it(`a second ${code} → 409 VERSION_CONFLICT with conflictParams`, async () => {
      const { db, levels } = fakeDb();
      const err = await withTx(
        db,
        async () => {
          throw pgError(code);
        },
        { conflictParams: async () => ({ currentVersion: 7 }) },
      ).catch((e: unknown) => e);
      expect(levels).toHaveLength(2);
      expect(err).toBeInstanceOf(AppProblem);
      expect((err as AppProblem).body()).toEqual({
        type: '/problems/version-conflict',
        title: 'Version conflict',
        status: 409,
        code: 'VERSION_CONFLICT',
        params: { currentVersion: 7 },
      });
    });
  }

  it('retryOnce: false → the first 40P01 is already a 409 (no params without conflictParams)', async () => {
    const { db, levels } = fakeDb();
    const err = (await withTx(
      db,
      async () => {
        throw pgError('40P01');
      },
      { retryOnce: false },
    ).catch((e: unknown) => e)) as AppProblem;
    expect(levels).toHaveLength(1);
    expect(err.body()).not.toHaveProperty('params');
    expect(err.status).toBe(409);
  });

  it('any other error propagates untouched, without a retry', async () => {
    const { db, levels } = fakeDb();
    const boom = pgError('23505');
    await expect(
      withTx(db, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(levels).toHaveLength(1);
  });
});
