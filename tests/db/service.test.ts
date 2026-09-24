import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { appPool, withTx, expectPgError, expectPgErrorIn, insertOrg, ownerPool } from './helpers';

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
  it('processed_events: the second claim of the same event inserts 0 rows (R56)', () =>
    withTx(async (c) => {
      const claim = (id: string) =>
        c.query(
          `INSERT INTO processed_events(event_id, backend) VALUES ($1, 'laravel') ON CONFLICT DO NOTHING`,
          [id],
        );
      const id = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
      expect((await claim(id)).rowCount).toBe(1);
      expect((await claim(id)).rowCount).toBe(0);
      const r = await c.query(`SELECT processed_at FROM processed_events WHERE event_id = $1`, [id]);
      expect(r.rows[0].processed_at).toBeInstanceOf(Date);
      await c.query('SAVEPOINT s');
      await expectPgError(
        c.query(`INSERT INTO processed_events(event_id, backend) VALUES (gen_random_uuid(), 'go')`),
        '23514',
      );
    }));

  it('outbox_events: defaults, backend CHECK, app role can claim unpublished rows (R55)', () =>
    withTx(async (c) => {
      const r = await c.query(
        `INSERT INTO outbox_events(backend, type, payload) VALUES ('django','recall.requested','{"id":"x"}')
         RETURNING id, attempts, published_at, created_at`,
      );
      expect(r.rows[0].attempts).toBe(0);
      expect(r.rows[0].published_at).toBeNull();
      expect(r.rows[0].created_at).toBeInstanceOf(Date);
      const claimed = await c.query(
        `SELECT id FROM outbox_events WHERE backend = 'django' AND published_at IS NULL
         ORDER BY created_at FOR UPDATE SKIP LOCKED`,
      );
      expect(claimed.rows.map((x) => x.id)).toContain(r.rows[0].id);
      await c.query(`UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = $1`, [
        r.rows[0].id,
      ]);
      await c.query('SAVEPOINT s');
      await expectPgError(
        c.query(`INSERT INTO outbox_events(backend, type, payload) VALUES ('go','x','{}')`),
        '23514',
      );
      await c.query('ROLLBACK TO SAVEPOINT s');
      const idx = await c.query(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'outbox_events' AND indexdef LIKE '%published_at IS NULL%'`,
      );
      expect(idx.rows[0]?.indexdef).toMatch(/\(backend, created_at\)/);
    }));

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
          `INSERT INTO audit_log(action, entity_type, entity_id, diff, backend) VALUES ('a','batch',gen_random_uuid(),'{}','rails')`,
        ),
        '23514',
      );
    }));

  it('audit_log.entity_type is one of AuditEntityType (R84)', () =>
    withTx(async (c) => {
      const ins = `INSERT INTO audit_log(action, entity_type, entity_id, diff, backend) VALUES ('a',$1,gen_random_uuid(),'{}','express')`;
      await c.query(ins, ['labTest']);
      await expectPgErrorIn(c, ins, ['lab_test'], '23514');
      await expectPgErrorIn(c, ins, ['Batch'], '23514');
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
