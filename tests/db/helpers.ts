import pg from 'pg';

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
