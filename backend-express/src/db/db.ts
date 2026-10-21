/** Kysely over a pg Pool. Types: types.generated.ts (`./at.sh gen:db-types`, kysely-codegen against agrotrace_test). */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './types.generated.js';

export type Db = Kysely<DB>;

// `date` stays the string PostgreSQL prints (YYYY-MM-DD): node-pg would build a Date at local midnight, which shifts
// with the container TZ. timestamptz → Date (an instant, TZ-safe); numeric and int8 are strings by default. Matches
// kysely-codegen --date-parser string --numeric-parser string.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * Connection budget (P61; contract info.description «Бюджет соединений с PostgreSQL»): one backend uses at most 20
 * connections of the shared PostgreSQL — api 11 (+ 1 LISTEN session of the SSE hub, sse/hub.ts), worker 4 (two
 * consumer channels with one handler each, the relay after a handler's commit, delivery and the Telegram poller),
 * scheduler 4 (scheduler/runner.ts: DB_POOL_MAX ≥ jobs + 1). DB_POOL_MAX overrides it for one process.
 */
export const POOL_DEFAULTS = { api: 11, worker: 4, scheduler: 4 } as const;
export type DbProcess = keyof typeof POOL_DEFAULTS;

export function poolMax(configured: number | undefined, process: DbProcess): number {
  return configured ?? POOL_DEFAULTS[process];
}

export function createDb(opts: {
  url: string;
  max: number;
  applicationName: string;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}): {
  db: Db;
  pool: pg.Pool;
} {
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.max,
    application_name: opts.applicationName,
    // An exhausted pool fails fast (→ 503 BACKEND_UNAVAILABLE) instead of queueing requests indefinitely (P61).
    connectionTimeoutMillis: opts.connectTimeoutMs,
    idleTimeoutMillis: 10_000,
    // Every session in UTC, whatever the container's TZ (Review Focus 4); statement and lock waits bounded (P61).
    options: `-c TimeZone=UTC -c statement_timeout=${opts.statementTimeoutMs} -c lock_timeout=${opts.lockTimeoutMs}`,
  });
  return { db: new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }), pool };
}
