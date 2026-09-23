import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { appPool, withTx, expectPgError, insertOrg, ownerPool } from './helpers';

async function user(c: pg.PoolClient) {
  const org = await insertOrg(c);
  const id = (
    await c.query(
      `INSERT INTO users(organization_id, email, password_hash, full_name, status)
     VALUES ($1, gen_random_uuid()::text || '@t.ru', 'x', 'Тест', 'ACTIVE') RETURNING id`,
      [org],
    )
  ).rows[0].id as string;
  return { id, orgId: org };
}

describe('service schema', () => {
  it('app role cannot update or delete audit_log', () =>
    withTx(async (c) => {
      await c.query(`INSERT INTO audit_log(action, entity_type, entity_id, diff, backend) VALUES ('create','batch',gen_random_uuid(),'{}','express')`);
      await c.query('SAVEPOINT s');
      await expectPgError(c.query(`UPDATE audit_log SET action='x'`), '42501');
      await c.query('ROLLBACK TO SAVEPOINT s');
      await expectPgError(c.query(`DELETE FROM audit_log`), '42501');
    }));

  it('rejects unknown backend in audit_log', () =>
    withTx(async (c) => {
      await expectPgError(
        c.query(`INSERT INTO audit_log(action, entity_type, entity_id, diff, backend) VALUES ('a','b',gen_random_uuid(),'{}','rails')`),
        '23514',
      );
    }));

  it('emits pg_notify on committed notification only', async () => {
    const listener = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    await listener.connect();
    const got: string[] = [];
    listener.on('notification', (m) => got.push(m.payload ?? ''));
    await listener.query('LISTEN notifications');

    const c = await appPool.connect();
    let uid = '';
    let orgId = '';
    try {
      await c.query('BEGIN');
      ({ id: uid, orgId } = await user(c));
      await c.query(`INSERT INTO notifications(user_id, type, payload) VALUES ($1,'RECALL','{}')`, [uid]);
      await c.query('ROLLBACK');
      await new Promise((r) => setTimeout(r, 200));
      expect(got).toHaveLength(0);

      await c.query('BEGIN');
      ({ id: uid, orgId } = await user(c));
      const n = (
        await c.query(`INSERT INTO notifications(user_id, type, payload) VALUES ($1,'RECALL','{}') RETURNING id`, [uid])
      ).rows[0].id;
      await c.query('COMMIT');
      await new Promise((r) => setTimeout(r, 200));
      expect(got).toHaveLength(1);
      expect(JSON.parse(got[0]!)).toEqual({ id: n, user_id: uid });
    } finally {
      c.release();
      await listener.end();
      // cleanup committed rows so reruns stay clean
      await ownerPool.query('DELETE FROM notifications WHERE user_id=$1', [uid]);
      await ownerPool.query('DELETE FROM users WHERE id=$1', [uid]);
      await ownerPool.query('DELETE FROM organizations WHERE id=$1', [orgId]);
    }
  });
});
