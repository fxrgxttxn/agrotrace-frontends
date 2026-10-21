/**
 * The sanctioned test-stand DB writes (contract «Записи тестового стенда в общую БД», P48/P51/P59) and the rule for
 * reads, enforced at RUNTIME by lib/db.ts: `fixtureWrite`/`holdRowLock` throw on a statement that is not one whole
 * entry of this list, `query` (the read-only pool) throws on anything but a plain read. fixture-writes.test.ts checks
 * that every entry is used and named in the contract.
 */

const ID = String.raw`(\$1|ANY\(\$1(::uuid\[\])?\))`;
const INTERVAL = String.raw`interval '[0-9a-z ]+'`;
const re = (s: string) => new RegExp(`^${s}$`);
const exact = (s: string) => re(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const COLS = '(user_id|type|payload|channel|delivery_status|attempts|created_at|claimed_at)';
const VALS = String.raw`(\$\d|'[A-Z_]+'|\d+|now\(\)( - ${INTERVAL})?)`;

/** Each entry: the whole (whitespace-normalized) statement and the contract's name of the fixture. */
export const SANCTIONED: readonly { sql: RegExp; contract: string }[] = [
  {
    sql: re(String.raw`UPDATE lab_tests SET due_at = now\(\) [-+] ${INTERVAL} WHERE id = ${ID}`),
    contract: '`lab_tests.due_at`',
  },
  {
    sql: re(
      String.raw`UPDATE recall_tasks SET due_at = now\(\) - ${INTERVAL} WHERE id = \$1( RETURNING due_at)?`,
    ),
    contract: '`recall_tasks.due_at`',
  },
  {
    sql: re(String.raw`UPDATE lab_tests SET created_at = '[0-9T:.Z-]+' WHERE id = \$1`),
    contract: '`lab_tests.created_at`',
  },
  {
    sql: re(String.raw`UPDATE treatments SET created_at = now\(\) - ${INTERVAL} WHERE id = \$1`),
    contract: '`treatments.created_at`',
  },
  {
    sql: re(String.raw`UPDATE users SET locked_until = now\(\) - ${INTERVAL} WHERE email = \$1`),
    contract: '`users.locked_until`',
  },
  {
    sql: re(String.raw`UPDATE batches SET deleted_at = now\(\) WHERE id = ${ID}`),
    contract: '`batches.deleted_at`',
  },
  {
    sql: re(String.raw`UPDATE recalls SET deleted_at = now\(\) WHERE id = \$1`),
    contract: '`recalls.deleted_at`',
  },
  {
    sql: re(String.raw`UPDATE organizations SET deleted_at = now\(\) WHERE id = \$1`),
    contract: '`organizations.deleted_at`',
  },
  {
    sql: re(String.raw`UPDATE users SET status = '(INVITED|ACTIVE|BLOCKED)' WHERE (id|email) = \$1`),
    contract: '`users.status`',
  },
  {
    sql: re(String.raw`UPDATE users SET telegram_chat_id = \d+ WHERE id = \$1`),
    contract: '`users.telegram_chat_id`',
  },
  { sql: exact('DELETE FROM fields WHERE id = $1 AND deleted_at IS NOT NULL'), contract: 'строки `fields`' },
  {
    // Notification columns only; values are parameters, literals and now() [- interval].
    sql: re(
      String.raw`INSERT INTO notifications \(${COLS}(, ${COLS})*\) VALUES \(${VALS}(, ${VALS})*\) RETURNING id(, seq)?`,
    ),
    contract: 'строка `notifications`',
  },
  {
    sql: exact(
      "WITH killed AS ( SELECT pg_terminate_backend(pid, 5000) AS ok FROM pg_stat_activity WHERE datname = current_database() AND query = 'LISTEN notifications' AND pid <> pg_backend_pid()) INSERT INTO notifications (user_id, type, payload, channel, delivery_status) SELECT $1, 'COMPLAINT', $2, 'IN_APP', 'DELIVERED' FROM (SELECT count(*) AS n FROM killed) k WHERE k.n > 0 RETURNING id, (SELECT count(*)::int FROM killed) AS killed",
    ),
    contract: '`pg_terminate_backend`',
  },
  {
    sql: re(String.raw`UPDATE outbox_events SET published_at = NULL WHERE id = ${ID}`),
    contract: '`outbox_events.published_at = NULL`',
  },
  { sql: exact('DELETE FROM processed_events WHERE event_id = $1'), contract: 'строки `processed_events`' },
  { sql: exact('SELECT id FROM indicators WHERE id = $1 FOR UPDATE'), contract: '`indicators` `FOR UPDATE`' },
  { sql: exact('SELECT id FROM fields WHERE id = $1 FOR UPDATE'), contract: '`fields` `FOR UPDATE`' },
];

export const normalizeSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/** The index of the entry `sql` is (one statement, whole match), or -1. */
export function sanctionedIndex(sql: string): number {
  const s = normalizeSql(sql);
  if (s.includes(';')) return -1;
  return SANCTIONED.findIndex((e) => e.sql.test(s));
}

/** What a read on the read-only pool must never contain (it could switch the session to writing or write). */
export const NOT_A_READ: readonly RegExp[] = [
  /;/,
  /\b(begin|start|commit|rollback|savepoint|set|reset|update|insert|delete|merge|truncate|alter|drop|create|copy|lock|grant|revoke|do|call|vacuum|prepare|execute|discard)\b/i,
  /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i,
  /\b(pg_terminate_backend|pg_cancel_backend|set_config|nextval|setval|pg_advisory\w*|pg_notify|lo_\w+|dblink\w*)\s*\(/i,
];

export function assertRead(sql: string): void {
  const bad = NOT_A_READ.find((r) => r.test(sql));
  if (bad) throw new Error(`lib/db query(): not a plain read (${bad}): ${normalizeSql(sql)}`);
}

export function assertSanctioned(sql: string): void {
  if (sanctionedIndex(sql) < 0)
    throw new Error(`lib/db: not a sanctioned fixture write (contract P59): ${normalizeSql(sql)}`);
}
