import { describe, it, expect } from 'vitest';
import { withTx, expectPgError, expectPgErrorIn, insertOrg } from './helpers';

describe('iam schema', () => {
  it('generates uuid and timestamps for organizations', () =>
    withTx(async (c) => {
      const id = await insertOrg(c);
      const r = await c.query(
        'SELECT id, created_at, updated_at, trust_rating, deleted_at FROM organizations WHERE id=$1',
        [id],
      );
      expect(r.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.rows[0].trust_rating).toBe(80);
      expect(r.rows[0].deleted_at).toBeNull();
    }));

  it('rejects unknown organization type', () =>
    withTx(async (c) => {
      await expectPgError(insertOrg(c, 'BANK'), '23514');
    }));

  it('enforces unique inn', () =>
    withTx(async (c) => {
      await insertOrg(c, 'FARM', '3300000001');
      await expectPgError(insertOrg(c, 'LAB', '3300000001'), '23505');
    }));

  it('touches updated_at on update', () =>
    withTx(async (c) => {
      const id = await insertOrg(c);
      await c.query(`UPDATE organizations SET updated_at = '2000-01-01Z' WHERE id=$1`, [id]);
      await c.query(`UPDATE organizations SET name='Другое' WHERE id=$1`, [id]);
      const r = await c.query('SELECT updated_at = now() AS touched FROM organizations WHERE id=$1', [id]);
      expect(r.rows[0].touched).toBe(true);
    }));

  it('enforces case-insensitive unique email', () =>
    withTx(async (c) => {
      const org = await insertOrg(c);
      const ins = (email: string) =>
        c.query(
          `INSERT INTO users(organization_id, email, password_hash, full_name, status) VALUES ($1,$2,'x','Иванов И.И.','ACTIVE')`,
          [org, email],
        );
      await ins('A@b.ru');
      await expectPgError(ins('a@B.ru'), '23505');
    }));

  it('seeds 6 roles', () =>
    withTx(async (c) => {
      const r = await c.query('SELECT code FROM roles ORDER BY code');
      expect(r.rows.map((x) => x.code)).toEqual(['ADMIN', 'FARMER', 'INSPECTOR', 'LAB', 'PROCESSOR', 'RETAILER']);
    }));

  it('keeps norms unique per product and indicator', () =>
    withTx(async (c) => {
      const p = (
        await c.query(`INSERT INTO products(name, category, loss_norm_percent) VALUES ('Тест','GRAIN',2.5) RETURNING id`)
      ).rows[0].id;
      const i = (await c.query(`INSERT INTO indicators(name, unit) VALUES ('Тест','мг/кг') RETURNING id`)).rows[0].id;
      await c.query('INSERT INTO norms(product_id, indicator_id, max_value) VALUES ($1,$2,0.05)', [p, i]);
      await expectPgError(
        c.query('INSERT INTO norms(product_id, indicator_id, max_value) VALUES ($1,$2,0.1)', [p, i]),
        '23505',
      );
    }));

  it('trust_rating: 80 by default for FARM only, NULL for other types; FARM ⇔ rating (R84)', () =>
    withTx(async (c) => {
      const farm = await insertOrg(c, 'FARM');
      const lab = await insertOrg(c, 'LAB');
      const r = await c.query('SELECT id, trust_rating FROM organizations WHERE id = ANY($1)', [[farm, lab]]);
      const byId = Object.fromEntries(r.rows.map((x) => [x.id, x.trust_rating]));
      expect(byId[farm]).toBe(80);
      expect(byId[lab]).toBeNull();
      const ins = `INSERT INTO organizations(type, name, inn, region_id, trust_rating)
                   VALUES ($1, 'Тест', $2, (SELECT id FROM regions LIMIT 1), $3) RETURNING trust_rating`;
      const C = 'organizations_trust_rating_farm';
      await expectPgErrorIn(c, ins, ['PROCESSOR', '3301000002', 80], '23514', C);
      await expectPgErrorIn(c, 'UPDATE organizations SET trust_rating = NULL WHERE id = $1', [farm], '23514', C);
      await expectPgErrorIn(c, 'UPDATE organizations SET trust_rating = 70 WHERE id = $1', [lab], '23514', C);
      expect((await c.query(ins, ['FARM', '3301000001', 55])).rows[0].trust_rating).toBe(55);
    }));

  it('rejects loss norm outside 0..100', () =>
    withTx(async (c) => {
      await expectPgError(
        c.query(`INSERT INTO products(name, category, loss_norm_percent) VALUES ('X','GRAIN',101)`),
        '23514',
      );
    }));
});
