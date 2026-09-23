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
      await c.query(
        `INSERT INTO audit_log(action, entity_type, entity_id, diff, backend) VALUES ('create','batch',gen_random_uuid(),'{}','express')`,
      );
      await c.query('SAVEPOINT s');
      await expectPgError(c.query(`UPDATE audit_log SET action='x'`), '42501');
      await c.query('ROLLBACK TO SAVEPOINT s');
      await expectPgError(c.query(`DELETE FROM audit_log`), '42501');
    }));

  it('rejects unknown backend in audit_log', () =>
    withTx(async (c) => {
      await expectPgError(
        c.query(
          `INSERT INTO audit_log(action, entity_type, entity_id, diff, backend) VALUES ('a','b',gen_random_uuid(),'{}','rails')`,
        ),
        '23514',
      );
    }));

  it('emits pg_notify on committed notification only', async () => {
    const listener = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    await listener.connect();
    const got: { id: string; user_id: string }[] = [];
    listener.on('notification', (m) => {
      if (!m.payload) return;
      got.push(JSON.parse(m.payload));
    });
    await listener.query('LISTEN notifications');

    const c = await appPool.connect();
    let uid = '';
    let orgId = '';
    let txOpen = false;
    try {
      await c.query('BEGIN');
      txOpen = true;
      ({ id: uid, orgId } = await user(c));
      await c.query(`INSERT INTO notifications(user_id, type, payload) VALUES ($1,'RECALL','{}')`, [uid]);
      await c.query('ROLLBACK');
      txOpen = false;
      // negative case: no listener callback runs a fixed window after a rolled-back insert
      await new Promise((r) => setTimeout(r, 300));
      expect(got.filter((n) => n.user_id === uid)).toHaveLength(0);

      await c.query('BEGIN');
      txOpen = true;
      ({ id: uid, orgId } = await user(c));
      const n = (
        await c.query(
          `INSERT INTO notifications(user_id, type, payload) VALUES ($1,'RECALL','{}') RETURNING id`,
          [uid],
        )
      ).rows[0].id;
      await c.query('COMMIT');
      txOpen = false;

      // positive case: poll (bounded by a deadline) instead of a fixed sleep
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !got.some((x) => x.user_id === uid)) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const mine = got.filter((x) => x.user_id === uid);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toEqual({ id: n, user_id: uid });
    } finally {
      if (txOpen) await c.query('ROLLBACK').catch(() => {});
      c.release();
      await listener.end();
      // cleanup committed rows so reruns stay clean (never delete with an empty uid)
      if (uid) {
        await ownerPool.query('DELETE FROM notifications WHERE user_id=$1', [uid]);
        await ownerPool.query('DELETE FROM users WHERE id=$1', [uid]);
      }
      if (orgId) await ownerPool.query('DELETE FROM organizations WHERE id=$1', [orgId]);
    }
  });

  it('emits no pg_notify for EMAIL channel notifications', async () => {
    const listener = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    await listener.connect();
    const got: { id: string; user_id: string }[] = [];
    listener.on('notification', (m) => {
      if (!m.payload) return;
      got.push(JSON.parse(m.payload));
    });
    await listener.query('LISTEN notifications');

    const c = await appPool.connect();
    let uid = '';
    let orgId = '';
    let txOpen = false;
    try {
      await c.query('BEGIN');
      txOpen = true;
      ({ id: uid, orgId } = await user(c));
      await c.query(
        `INSERT INTO notifications(user_id, type, payload, channel) VALUES ($1,'RECALL','{}','EMAIL')`,
        [uid],
      );
      await c.query('COMMIT');
      txOpen = false;

      await new Promise((r) => setTimeout(r, 300));
      expect(got.filter((n) => n.user_id === uid)).toHaveLength(0);
    } finally {
      if (txOpen) await c.query('ROLLBACK').catch(() => {});
      c.release();
      await listener.end();
      if (uid) {
        await ownerPool.query('DELETE FROM notifications WHERE user_id=$1', [uid]);
        await ownerPool.query('DELETE FROM users WHERE id=$1', [uid]);
      }
      if (orgId) await ownerPool.query('DELETE FROM organizations WHERE id=$1', [orgId]);
    }
  });
});
