import pg from 'pg';
import { assertTestDatabase } from './guard';

// Refuse before any pool exists (R83): never a dev or production database.
assertTestDatabase(process.env.DATABASE_URL, 'DATABASE_URL');
assertTestDatabase(process.env.APP_DATABASE_URL, 'APP_DATABASE_URL');

export const appPool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
export const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL?.replace('?sslmode=disable', '') });

export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

export async function expectPgError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    if ((e as { code?: string }).code === code) return;
    throw e;
  }
  throw new Error(`expected pg error ${code}`);
}

let innCounter = 0;

function defaultInn(): string {
  innCounter = (innCounter + 1) % 100;
  const millis = String(Date.now()).slice(-6);
  const rand = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  return `${millis}${String(innCounter).padStart(2, '0')}${rand}`;
}

export async function insertOrg(c: pg.PoolClient, type = 'FARM', inn = defaultInn()) {
  const r = await c.query(
    `INSERT INTO organizations(type, name, inn, region_id, status)
     VALUES ($1, 'Тест', $2, (SELECT id FROM regions LIMIT 1), 'ACTIVE') RETURNING id`,
    [type, inn],
  );
  return r.rows[0].id as string;
}

/**
 * Runs `sql` inside a savepoint and expects it to fail with `code` (and, when given, on `constraint`);
 * the savepoint is rolled back so the surrounding transaction stays usable.
 */
export async function expectPgErrorIn(
  c: pg.PoolClient,
  sql: string,
  params: unknown[],
  code: string,
  constraint?: string,
) {
  await c.query('SAVEPOINT expect_error');
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT expect_error');
    const err = e as { code?: string; constraint?: string };
    if (err.code !== code) throw e;
    if (constraint !== undefined && err.constraint !== constraint)
      throw new Error(`expected constraint ${constraint}, got ${String(err.constraint)}`);
    return;
  }
  await c.query('RELEASE SAVEPOINT expect_error');
  throw new Error(`expected pg error ${code}: ${sql}`);
}
