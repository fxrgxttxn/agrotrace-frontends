import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { withTx, expectPgError, insertOrg } from './helpers';

async function product(c: pg.PoolClient) {
  return (await c.query(`INSERT INTO products(name, category, loss_norm_percent) VALUES ('Пшеница','GRAIN',2) RETURNING id`))
    .rows[0].id as string;
}
async function batch(c: pg.PoolClient, org: string, p: string, mass = '100.000', status = 'Created') {
  return (
    await c.query(
      `INSERT INTO batches(public_code, product_id, origin_org_id, holder_org_id, kind, mass_kg, harvested_at, status)
     VALUES (next_batch_code(), $1, $2, $2, 'RAW', $3, now(), $4) RETURNING id, public_code`,
      [p, org, mass, status],
    )
  ).rows[0];
}

describe('production schema', () => {
  it('generates sequential batch codes AT-YYYY-NNNNNN', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const p = await product(c);
      const a = await batch(c, org, p);
      const b = await batch(c, org, p);
      const year = new Date().getUTCFullYear();
      expect(a.public_code).toMatch(new RegExp(`^AT-${year}-\\d{6,}$`));
      expect(Number(b.public_code.split('-')[2])).toBe(Number(a.public_code.split('-')[2]) + 1);
    }));

  it('rejects non-positive mass', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const p = await product(c);
      await expectPgError(batch(c, org, p, '0.000'), '23514');
    }));

  it('stores mass exactly with 3 decimals', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const p = await product(c);
      const b = await batch(c, org, p, '999999999.999');
      const r = await c.query('SELECT mass_kg::text AS m FROM batches WHERE id=$1', [b.id]);
      expect(r.rows[0].m).toBe('999999999.999');
    }));

  it('rejects unknown batch status', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const p = await product(c);
      await expectPgError(batch(c, org, p, '1.000', 'Lost'), '23514');
    }));

  it('forbids self-loop edges', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const p = await product(c);
      const a = await batch(c, org, p);
      await expectPgError(
        c.query('INSERT INTO batch_links(parent_batch_id, child_batch_id, mass_used_kg) VALUES ($1,$1,1)', [a.id]),
        '23514',
      );
    }));

  it('has index on batch_links(child_batch_id)', () =>
    withTx(async (c) => {
      const r = await c.query(`SELECT indexdef FROM pg_indexes WHERE tablename='batch_links'`);
      expect(r.rows.some((x) => /\(child_batch_id\)/.test(x.indexdef))).toBe(true);
    }));

  it('generates waybill numbers', () =>
    withTx(async (c) => {
      const r = await c.query('SELECT next_waybill_number() AS n');
      expect(r.rows[0].n).toMatch(/^WB-\d{4}-\d{6,}$/);
    }));

  it('rejects waybill to self', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      await expectPgError(
        c.query(
          `INSERT INTO waybills(number, sender_org_id, receiver_org_id, status) VALUES (next_waybill_number(), $1, $1, 'DRAFT')`,
          [org],
        ),
        '23514',
      );
    }));
});
