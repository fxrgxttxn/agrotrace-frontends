import pg from 'pg';
import { envFromProcess, KEPT_TABLES } from '../../src/seed';

export const env = envFromProcess();

export async function withDb<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: env.databaseUrl });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

/** md5 of every data table's rows in a stable order (the seed's determinism check). */
export async function tableChecksums(db: pg.Client): Promise<Record<string, string>> {
  const tables = (
    await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT (tablename = ANY($1)) ORDER BY tablename`,
      [KEPT_TABLES],
    )
  ).rows.map((r) => r.tablename);
  const out: Record<string, string> = {};
  for (const t of tables) {
    const r = await db.query<{ md5: string | null; n: string }>(
      `SELECT md5(string_agg(x.t, E'\\n' ORDER BY x.t)) AS md5, count(*) AS n FROM (SELECT (tb.*)::text AS t FROM ${t} tb) x`,
    );
    out[t] = `${r.rows[0]!.n}:${r.rows[0]!.md5 ?? ''}`;
  }
  for (const s of ['batch_code_seq', 'waybill_number_seq']) {
    out[s] = String(
      (await db.query<{ last_value: string }>(`SELECT last_value FROM ${s}`)).rows[0]!.last_value,
    );
  }
  return out;
}
