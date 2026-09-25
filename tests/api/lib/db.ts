/**
 * Read-only access to the dev DB for side effects the contract names but no API response shows — above all the
 * transactional outbox (R55, P1: an operation's event is an `outbox_events` row written in its transaction). Every
 * session is read-only (`default_transaction_read_only`), so tests can never change data behind the API's back.
 *
 * URL: TESTS_DATABASE_URL, else APP_DATABASE_URL (the tools container gets .env).
 */
import pg from 'pg';

let pool: pg.Pool | null = null;

function db(): pg.Pool {
  const url = process.env.TESTS_DATABASE_URL ?? process.env.APP_DATABASE_URL;
  if (!url) throw new Error('lib/db: set TESTS_DATABASE_URL or APP_DATABASE_URL');
  pool ??= new pg.Pool({
    connectionString: url,
    max: 2,
    options: '-c default_transaction_read_only=on -c TimeZone=UTC',
  });
  return pool;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows of ad-hoc queries
export async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(sql, params)).rows as T[];
}

export interface OutboxRow {
  id: string;
  backend: string;
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the envelope (contracts/events/envelope.schema.json)
  payload: Record<string, any>;
  created_at: Date;
  published_at: Date | null;
}

/**
 * Outbox rows written by `backend` since `since` (default: all), optionally of one event type, oldest first.
 * Filter further on `payload.data` in the test (e.g. the batch id).
 */
export async function outboxEvents(opts: {
  backend: string;
  type?: string;
  since?: Date;
}): Promise<OutboxRow[]> {
  return query<OutboxRow>(
    `SELECT id, backend, type, payload, created_at, published_at FROM outbox_events
      WHERE backend = $1 AND ($2::text IS NULL OR type = $2) AND ($3::timestamptz IS NULL OR created_at >= $3)
      ORDER BY created_at, id`,
    [opts.backend, opts.type ?? null, opts.since ?? null],
  );
}

/** The DB clock (outbox `created_at` is DB time; use it as `since`, not the test process clock). */
export async function dbNow(): Promise<Date> {
  return (await query<{ now: Date }>('SELECT now() AS now'))[0]!.now;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}
