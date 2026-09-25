/** Kysely over a pg Pool. Types: types.generated.ts (`./at.sh gen:db-types`, kysely-codegen against agrotrace_test). */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './types.generated.js';

export type Db = Kysely<DB>;

// `date` stays the string PostgreSQL prints (YYYY-MM-DD): node-pg would build a Date at local midnight, which shifts
// with the container TZ. timestamptz → Date (an instant, TZ-safe); numeric and int8 are strings by default. Matches
// kysely-codegen --date-parser string --numeric-parser string.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createDb(opts: { url: string; max: number; applicationName: string }): {
  db: Db;
  pool: pg.Pool;
} {
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.max,
    application_name: opts.applicationName,
    // Every session in UTC, whatever the container's TZ (Review Focus 4).
    options: '-c TimeZone=UTC',
  });
  return { db: new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }), pool };
}
