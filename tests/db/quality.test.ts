import { describe, it } from 'vitest';
import type pg from 'pg';
import { withTx, expectPgError, insertOrg } from './helpers';

async function rawBatch(c: pg.PoolClient) {
  const org = await insertOrg(c);
  const p = (await c.query(`INSERT INTO products(name, category, loss_norm_percent) VALUES ('П','GRAIN',1) RETURNING id`))
    .rows[0].id;
  return (
    await c.query(
      `INSERT INTO batches(public_code, product_id, origin_org_id, holder_org_id, kind, mass_kg, harvested_at)
    VALUES (next_batch_code(), $1, $2, $2, 'RAW', 10, now()) RETURNING id`,
      [p, org],
    )
  ).rows[0].id as string;
}

describe('quality schema', () => {
  it('allows only one OPEN recall per source batch', () =>
    withTx(async (c) => {
      const b = await rawBatch(c);
      const ins = () =>
        c.query(`INSERT INTO recalls(source_batch_id, trigger, reason, status) VALUES ($1,'INSPECTOR','x','OPEN')`, [b]);
      await ins();
      await expectPgError(ins(), '23505');
    }));

  it('allows a new recall after the previous one closed', () =>
    withTx(async (c) => {
      const b = await rawBatch(c);
      await c.query(
        `INSERT INTO recalls(source_batch_id, trigger, reason, status, closed_at) VALUES ($1,'INSPECTOR','x','CLOSED', now())`,
        [b],
      );
      await c.query(`INSERT INTO recalls(source_batch_id, trigger, reason, status) VALUES ($1,'INSPECTOR','y','OPEN')`, [b]);
    }));

  it('rejects conclusion outside PASS/FAIL', () =>
    withTx(async (c) => {
      const b = await rawBatch(c);
      const lab = await insertOrg(c, 'LAB', '3311111111');
      await expectPgError(
        c.query(
          `INSERT INTO lab_tests(batch_id, lab_org_id, reason, status, conclusion, due_at)
      VALUES ($1,$2,'RISK','DONE','MAYBE', now())`,
          [b, lab],
        ),
        '23514',
      );
    }));
});
