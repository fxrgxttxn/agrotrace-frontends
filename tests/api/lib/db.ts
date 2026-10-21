/**
 * Read-only access to the dev DB for side effects the contract names but no API response shows — above all the
 * transactional outbox (R55, P1: an operation's event is an `outbox_events` row written in its transaction). Every
 * session is read-only (`default_transaction_read_only`), so tests can never change data behind the API's back.
 *
 * URL: TESTS_DATABASE_URL, else APP_DATABASE_URL (the tools container gets .env).
 */
import pg from 'pg';
import { assertEvent } from './events.js';
import { assertRead, assertSanctioned } from './sanctioned.js';

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
  assertRead(sql); // P59: never a write or a session switch through the read-only pool
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
  const rows = await query<OutboxRow>(
    `SELECT id, backend, type, payload, created_at, published_at FROM outbox_events
      WHERE backend = $1 AND ($2::text IS NULL OR type = $2) AND ($3::timestamptz IS NULL OR created_at >= $3)
      ORDER BY created_at, id`,
    [opts.backend, opts.type ?? null, opts.since ?? null],
  );
  // Every row read is a valid queue document of its type (contracts/events, R55).
  for (const r of rows) assertEvent(r.payload);
  return rows;
}

/** The DB clock (outbox `created_at` is DB time; use it as `since`, not the test process clock). */
export async function dbNow(): Promise<Date> {
  return (await query<{ now: Date }>('SELECT now() AS now'))[0]!.now;
}

let writePool: pg.Pool | null = null;

/**
 * The one escape from read-only access: a write that sets up state the API cannot produce (yet) or a clock the test
 * cannot wait for (a 15-minute lockout). Every call site says why in a comment and, where an API will produce the
 * state later, names the task that replaces it (e.g. approveOrganization, Task 4). Never used to assert anything.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows of ad-hoc statements
export async function fixtureWrite<T = Record<string, any>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const url = process.env.TESTS_DATABASE_URL ?? process.env.APP_DATABASE_URL;
  if (!url) throw new Error('lib/db: set TESTS_DATABASE_URL or APP_DATABASE_URL');
  assertSanctioned(sql); // P59: only the contract's list (lib/sanctioned.ts)
  writePool ??= new pg.Pool({ connectionString: url, max: 1, options: '-c TimeZone=UTC' });
  return (await writePool.query(sql, params)).rows as T[];
}

/**
 * A row lock held by the test in a session of its own (sanctioned fixture, contract P59): runs `lockSql` (a
 * `SELECT … FOR UPDATE`) inside an open transaction and keeps it until `release()` (ROLLBACK — nothing is written).
 * It makes the interleaving of two parallel requests deterministic: a request that needs the row waits at a known
 * statement, observable through `blockedBy(pid)`.
 */
export async function holdRowLock(
  lockSql: string,
  params: unknown[] = [],
): Promise<{ pid: number; release(): Promise<void> }> {
  assertSanctioned(lockSql); // P59: only the contract's list (lib/sanctioned.ts)
  const url = process.env.TESTS_DATABASE_URL ?? process.env.APP_DATABASE_URL;
  if (!url) throw new Error('lib/db: set TESTS_DATABASE_URL or APP_DATABASE_URL');
  const client = new pg.Client({ connectionString: url, options: '-c TimeZone=UTC' });
  await client.connect();
  const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await client.query('BEGIN');
  await client.query(lockSql, params);
  return {
    pid,
    async release() {
      await client.query('ROLLBACK');
      await client.end();
    },
  };
}

/** Sessions waiting for a lock that session `pid` holds (pg_blocking_pids; read-only). */
export async function blockedBy(pid: number): Promise<number[]> {
  const rows = await query<{ pid: number }>(
    'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
    [pid],
  );
  return rows.map((r) => r.pid);
}

export async function closeDb(): Promise<void> {
  await Promise.all([pool?.end(), writePool?.end()]);
  pool = null;
  writePool = null;
}
