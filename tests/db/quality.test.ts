import { describe, it } from 'vitest';
import type pg from 'pg';
import { withTx, expectPgError, insertOrg } from './helpers';

async function rawBatch(c: pg.PoolClient) {
  const org = await insertOrg(c);
  const p = (
    await c.query(
      `INSERT INTO products(name, category, loss_norm_percent) VALUES ('П','GRAIN',1) RETURNING id`,
    )
  ).rows[0].id;
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
        c.query(
          `INSERT INTO recalls(source_batch_id, trigger, reason, status) VALUES ($1,'INSPECTOR','x','OPEN')`,
          [b],
        );
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
      await c.query(
        `INSERT INTO recalls(source_batch_id, trigger, reason, status) VALUES ($1,'INSPECTOR','y','OPEN')`,
        [b],
      );
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

  it('complaint decision links: LAB_TEST ⇔ lab_test_id, RECALL ⇔ recall_id, DECIDED ⇔ decided_at', () =>
    withTx(async (c) => {
      const b = await rawBatch(c);
      const recall = (
        await c.query(
          `INSERT INTO recalls(source_batch_id, trigger, reason) VALUES ($1,'COMPLAINT','x') RETURNING id`,
          [b],
        )
      ).rows[0].id;
      const ins = (
        status: string,
        decision: string | null,
        decidedAt: boolean,
        recallId: string | null = null,
      ) =>
        c.query(
          `INSERT INTO complaints(batch_id, text, status, decision, decided_at, recall_id)
           VALUES ($1, 'Горечь во рту после употребления', $2, $3, CASE WHEN $4 THEN now() END, $5)`,
          [b, status, decision, decidedAt, recallId],
        );
      await c.query('SAVEPOINT s');
      for (const [args, code] of [
        [['DECIDED', 'LAB_TEST', true], '23514'],
        [['DECIDED', 'RECALL', true], '23514'],
        [['DECIDED', 'REJECT', false], '23514'],
        [['DECIDED', 'REJECT', true, recall], '23514'],
        [['NEW', null, true], '23514'],
      ] as const) {
        await expectPgError((ins as (...a: unknown[]) => Promise<unknown>)(...args), code);
        await c.query('ROLLBACK TO SAVEPOINT s');
      }
      await ins('DECIDED', 'RECALL', true, recall);
      await ins('DECIDED', 'REJECT', true);
      await ins('NEW', null, false);
      // Positive LAB_TEST case (R59): DECIDED + LAB_TEST + lab_test_id + decided_at is accepted.
      const lab = await insertOrg(c, 'LAB');
      const test = (
        await c.query(
          `INSERT INTO lab_tests(batch_id, lab_org_id, reason, due_at) VALUES ($1,$2,'COMPLAINT', now()) RETURNING id`,
          [b, lab],
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO complaints(batch_id, text, status, decision, decided_at, lab_test_id)
         VALUES ($1, 'Горечь во рту после употребления', 'DECIDED', 'LAB_TEST', now(), $2)`,
        [b, test],
      );
    }));

  it('lab_tests.recall_id links only FAIL conclusions to a recall (R57)', () =>
    withTx(async (c) => {
      const b = await rawBatch(c);
      const lab = await insertOrg(c, 'LAB');
      const recall = (
        await c.query(
          `INSERT INTO recalls(source_batch_id, trigger, reason) VALUES ($1,'LAB','x') RETURNING id`,
          [b],
        )
      ).rows[0].id;
      const ins = (status: string, conclusion: string | null) =>
        c.query(
          `INSERT INTO lab_tests(batch_id, lab_org_id, reason, status, conclusion, due_at, recall_id)
           VALUES ($1, $2, 'RISK', $3, $4, now(), $5)`,
          [b, lab, status, conclusion, recall],
        );
      await c.query('SAVEPOINT s');
      await expectPgError(ins('DONE', 'PASS'), '23514');
      await c.query('ROLLBACK TO SAVEPOINT s');
      await expectPgError(ins('QUEUED', null), '23514');
      await c.query('ROLLBACK TO SAVEPOINT s');
      await ins('DONE', 'FAIL');
    }));

  it('recalls.block_upstream defaults to false', () =>
    withTx(async (c) => {
      const b = await rawBatch(c);
      const r = await c.query(
        `INSERT INTO recalls(source_batch_id, trigger, reason) VALUES ($1,'INSPECTOR','x') RETURNING block_upstream`,
        [b],
      );
      if (r.rows[0].block_upstream !== false) throw new Error(`block_upstream = ${r.rows[0].block_upstream}`);
    }));

  it('product names are unique', () =>
    withTx(async (c) => {
      const ins = () =>
        c.query(
          `INSERT INTO products(name, category, loss_norm_percent) VALUES ('Пшеница твёрдая','GRAIN',1)`,
        );
      await ins();
      await expectPgError(ins(), '23505');
    }));
});
