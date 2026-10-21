/**
 * P59 guard: every write the suite makes to the shared DB is one of the sanctioned fixtures the contract enumerates
 * (contracts/openapi.yaml, «Записи тестового стенда в общую БД»). The suite reads the DB through a read-only pool
 * (lib/db.ts `query`); the only write paths are `fixtureWrite` and `holdRowLock` (lib/db.ts). This test scans every
 * suite file for them, requires the SQL to be a literal matching one entry of the list, and requires each entry to be
 * named in the contract — a Django/Laravel port can rely on the list being complete.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = import.meta.dirname;
const CONTRACT = readFileSync(join(ROOT, '..', '..', 'contracts', 'openapi.yaml'), 'utf8').replace(
  /\s+/g,
  ' ',
);

/** The sanctioned list: a pattern of the (whitespace-normalized) SQL and the contract's name of the fixture. */
const SANCTIONED: { sql: RegExp; contract: string }[] = [
  { sql: /^UPDATE lab_tests SET due_at = /, contract: '`lab_tests.due_at`' },
  { sql: /^UPDATE recall_tasks SET due_at = /, contract: '`recall_tasks.due_at`' },
  { sql: /^UPDATE lab_tests SET created_at = /, contract: '`lab_tests.created_at`' },
  { sql: /^UPDATE treatments SET created_at = /, contract: '`treatments.created_at`' },
  { sql: /^UPDATE users SET locked_until = now\(\) - /, contract: '`users.locked_until`' },
  { sql: /^UPDATE batches SET deleted_at = now\(\) WHERE /, contract: '`batches.deleted_at`' },
  { sql: /^UPDATE recalls SET deleted_at = now\(\) WHERE /, contract: '`recalls.deleted_at`' },
  { sql: /^UPDATE organizations SET deleted_at = now\(\) WHERE /, contract: '`organizations.deleted_at`' },
  { sql: /^UPDATE users SET status = '(INVITED|ACTIVE|BLOCKED)' WHERE /, contract: '`users.status`' },
  { sql: /^UPDATE users SET telegram_chat_id = \d+ WHERE /, contract: '`users.telegram_chat_id`' },
  { sql: /^DELETE FROM fields WHERE id = \$1 AND deleted_at IS NOT NULL$/, contract: 'строки `fields`' },
  { sql: /^INSERT INTO notifications \(/, contract: 'строка `notifications`' },
  { sql: /^WITH killed AS \( SELECT pg_terminate_backend\(/, contract: '`pg_terminate_backend`' },
  {
    sql: /^UPDATE outbox_events SET published_at = NULL WHERE /,
    contract: '`outbox_events.published_at = NULL`',
  },
  { sql: /^DELETE FROM processed_events WHERE event_id = \$1$/, contract: 'строки `processed_events`' },
  { sql: /^SELECT id FROM indicators WHERE id = \$1 FOR UPDATE$/, contract: '`indicators` `FOR UPDATE`' },
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

const sources = files(ROOT).map((f) => ({
  file: relative(ROOT, f).replaceAll('\\', '/'),
  text: readFileSync(f, 'utf8'),
}));

describe('test-stand DB writes (P59)', () => {
  it('every fixtureWrite / holdRowLock call is a literal SQL of the sanctioned list', () => {
    const bad: string[] = [];
    const used = new Set<number>();
    let calls = 0;
    for (const { file, text } of sources) {
      if (file === 'lib/db.ts' || file === 'fixture-writes.test.ts') continue;
      for (const m of text.matchAll(/\b(fixtureWrite|holdRowLock)\s*(?:<[^>(]*>)?\(\s*(\S)/g)) {
        calls++;
        const quote = m[2]!;
        const start = m.index! + m[0].length;
        if (!["'", '`', '"'].includes(quote)) {
          bad.push(`${file}: ${m[1]} with a non-literal SQL`);
          continue;
        }
        const sql = text.slice(start, text.indexOf(quote, start)).replace(/\s+/g, ' ').trim();
        const i = SANCTIONED.findIndex((s) => s.sql.test(sql));
        if (i < 0) bad.push(`${file}: not sanctioned: ${sql}`);
        else used.add(i);
      }
    }
    expect(bad).toEqual([]);
    expect(calls).toBeGreaterThan(0);
    // The list stays exhaustive and minimal: an entry no test uses any more is removed (here and in the contract).
    expect(SANCTIONED.filter((_, i) => !used.has(i)).map((s) => s.contract)).toEqual([]);
  });

  it('the contract names every sanctioned fixture', () => {
    expect(CONTRACT).toMatch(/Записи тестового стенда в общую БД \(P48, P51, P59\)/);
    expect(SANCTIONED.filter((s) => !CONTRACT.includes(s.contract)).map((s) => s.contract)).toEqual([]);
  });

  it('no other write path: only lib/db.ts opens database connections, and its query pool is read-only', () => {
    const opening = sources
      .filter(({ file }) => file !== 'lib/db.ts' && file !== 'fixture-writes.test.ts')
      .filter(({ text }) => /from 'pg'|new pg\.|require\('pg'\)/.test(text))
      .map((s) => s.file);
    expect(opening).toEqual([]);
    const db = sources.find((s) => s.file === 'lib/db.ts')!.text;
    expect(db).toMatch(/default_transaction_read_only=on/);
  });
});
