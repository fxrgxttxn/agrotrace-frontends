import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { withTx, expectPgError, expectPgErrorIn, insertOrg } from './helpers';

async function product(c: pg.PoolClient) {
  return (
    await c.query(
      `INSERT INTO products(name, category, loss_norm_percent) VALUES ('Пшеница','GRAIN',2) RETURNING id`,
    )
  ).rows[0].id as string;
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

  it('requires QR png/pdf files and qr_generated_at to be all set or all null (R50)', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const p = await product(c);
      const b = await batch(c, org, p);
      const file = async () =>
        (
          await c.query(
            `INSERT INTO files(bucket, object_key, original_name, mime, size_bytes, sha256, kind)
             VALUES ('agrotrace', 'qr/' || gen_random_uuid(), 'AT.png', 'image/png', 1, repeat('a', 64), 'QR')
             RETURNING id`,
          )
        ).rows[0].id as string;
      const png = await file();
      const pdf = await file();
      await c.query('SAVEPOINT s');
      await expectPgError(
        c.query('UPDATE batches SET qr_png_file_id=$2, qr_generated_at=now() WHERE id=$1', [b.id, png]),
        '23514',
      );
      await c.query('ROLLBACK TO SAVEPOINT s');
      await expectPgError(
        c.query('UPDATE batches SET qr_png_file_id=$2, qr_pdf_file_id=$3 WHERE id=$1', [b.id, png, pdf]),
        '23514',
      );
      await c.query('ROLLBACK TO SAVEPOINT s');
      await c.query(
        'UPDATE batches SET qr_png_file_id=$2, qr_pdf_file_id=$3, qr_generated_at=now() WHERE id=$1',
        [b.id, png, pdf],
      );
    }));

  it('forbids self-loop edges', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const p = await product(c);
      const a = await batch(c, org, p);
      await expectPgError(
        c.query('INSERT INTO batch_links(parent_batch_id, child_batch_id, mass_used_kg) VALUES ($1,$1,1)', [
          a.id,
        ]),
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

  it('batches.test_reason defaults to NONE, is NOT NULL and checked (R84)', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const p = await product(c);
      const a = await batch(c, org, p);
      expect((await c.query('SELECT test_reason FROM batches WHERE id=$1', [a.id])).rows[0].test_reason).toBe(
        'NONE',
      );
      await expectPgErrorIn(c, 'UPDATE batches SET test_reason = NULL WHERE id=$1', [a.id], '23502');
      await expectPgErrorIn(c, `UPDATE batches SET test_reason = 'MAYBE' WHERE id=$1`, [a.id], '23514');
    }));

  it('treatments.dose_unit is one of DoseUnit (R84)', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const field = (
        await c.query(
          `INSERT INTO fields(organization_id, name, area_ha, region_id)
           VALUES ($1, 'Поле', 10, (SELECT id FROM regions LIMIT 1)) RETURNING id`,
          [org],
        )
      ).rows[0].id;
      const substance = (
        await c.query(
          `INSERT INTO substances(name, type, waiting_period_days) VALUES ('Тест-R84','PESTICIDE',30) RETURNING id`,
        )
      ).rows[0].id;
      const ins = `INSERT INTO treatments(field_id, substance_id, dose, dose_unit, applied_at) VALUES ($1,$2,1,$3,now())`;
      for (const unit of ['л/га', 'мл/га', 'кг/га', 'г/га']) await c.query(ins, [field, substance, unit]);
      await expectPgErrorIn(c, ins, [field, substance, 'т/га'], '23514');
    }));

  it('batch_status_history.reason is a NOT NULL BatchStatusReason (R84)', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const p = await product(c);
      const a = await batch(c, org, p);
      const ins = `INSERT INTO batch_status_history(batch_id, from_status, to_status, reason) VALUES ($1,'Created','Approved',$2)`;
      await c.query(ins, [a.id, 'TEST_NOT_REQUIRED']);
      await expectPgErrorIn(c, ins, [a.id, null], '23502');
      await expectPgErrorIn(c, ins, [a.id, 'Партия допущена'], '23514');
    }));

  it('batch_documents: one VSD per batch, PENDING by default, IMPORTED ⇔ document fields (R81)', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const p = await product(c);
      const a = await batch(c, org, p);
      const d = (
        await c.query(`INSERT INTO batch_documents(batch_id, kind) VALUES ($1,'VSD') RETURNING *`, [a.id])
      ).rows[0];
      expect(d).toMatchObject({ import_status: 'PENDING', attempts: 0, external_uuid: null, payload: null });
      await expectPgErrorIn(
        c,
        `INSERT INTO batch_documents(batch_id, kind) VALUES ($1,'VSD')`,
        [a.id],
        '23505',
      );
      await expectPgErrorIn(
        c,
        `INSERT INTO batch_documents(batch_id, kind) VALUES ($1,'CMR')`,
        [a.id],
        '23514',
      );
      const upd = 'UPDATE batch_documents SET import_status = $2 WHERE id = $1';
      await expectPgErrorIn(c, upd, [d.id, 'DONE'], '23514');
      await expectPgErrorIn(c, upd, [d.id, 'IMPORTED'], '23514', 'batch_documents_imported');
      await expectPgErrorIn(
        c,
        `UPDATE batch_documents SET external_uuid = gen_random_uuid(), import_status = 'IMPORTED' WHERE id = $1`,
        [d.id],
        '23514',
        'batch_documents_fields',
      );
      await c.query(
        `UPDATE batch_documents SET import_status = 'IMPORTED', external_uuid = gen_random_uuid(), number = 'VSD-1',
                issue_date = '2026-07-19', vsd_status = 'CONFIRMED', payload = '{}', attempts = 1 WHERE id = $1`,
        [d.id],
      );
      await expectPgErrorIn(
        c,
        `UPDATE batch_documents SET vsd_status = 'LOST' WHERE id = $1`,
        [d.id],
        '23514',
      );
      await expectPgErrorIn(c, `UPDATE batch_documents SET attempts = -1 WHERE id = $1`, [d.id], '23514');
      await expectPgErrorIn(c, `UPDATE products SET mercury_code = '10-51-11' WHERE id = $1`, [p], '23514');
      await c.query(`UPDATE products SET mercury_code = '10.51.11' WHERE id = $1`, [p]);
    }));

  it('rejects unknown status in batch_status_history', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const p = await product(c);
      const a = await batch(c, org, p);
      await expectPgError(
        c.query(
          `INSERT INTO batch_status_history(batch_id, from_status, to_status, reason) VALUES ($1,'Created','Lost','CREATED')`,
          [a.id],
        ),
        '23514',
      );
    }));
});
