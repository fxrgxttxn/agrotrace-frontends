/**
 * P59 guard: every write the suite makes to the shared DB is one of the sanctioned fixtures the contract enumerates
 * (contracts/openapi.yaml, «Записи тестового стенда в общую БД»; the list is lib/sanctioned.ts).
 *
 * Enforcement is at runtime in lib/db.ts, so dynamic SQL cannot slip past a static scan:
 * - `fixtureWrite`/`holdRowLock` throw unless the statement is ONE whole entry of the list (anchored patterns: no
 *   extra SET column, no second statement);
 * - `query` (the read-only pool) throws on anything but a plain read: no `;`, no transaction/session/DML/DDL
 *   keyword, no row lock, no writing function — `BEGIN READ WRITE` or `SET default_transaction_read_only` included.
 *
 * This file checks that enforcement, that every entry is used by a literal call and named in the contract, that
 * lib/db.ts is imported by name only (no alias, namespace import, re-export or passing it around) and that no other
 * file opens a database connection (any quote style).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertRead, assertSanctioned, normalizeSql, SANCTIONED, sanctionedIndex } from './lib/sanctioned.js';

const ROOT = import.meta.dirname;
const CONTRACT = readFileSync(join(ROOT, '..', '..', 'contracts', 'openapi.yaml'), 'utf8').replace(
  /\s+/g,
  ' ',
);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

const SELF = 'fixture-writes.test.ts';
const sources = files(ROOT)
  .map((f) => ({ file: relative(ROOT, f).replaceAll('\\', '/'), text: readFileSync(f, 'utf8') }))
  .filter((s) => s.file !== SELF && s.file !== 'lib/sanctioned.ts');
const suites = sources.filter((s) => s.file !== 'lib/db.ts');

/** First arguments of the calls of `name`: the literal SQL (normalized), or null when not a plain literal. */
function calls(text: string, name: string): (string | null)[] {
  const out: (string | null)[] = [];
  for (const m of text.matchAll(new RegExp(String.raw`(?<![.\w$])${name}\s*(?:<[^(]*?>)?\(\s*(\S)`, 'g'))) {
    const quote = m[1]!;
    const start = m.index! + m[0].length;
    if (!["'", '`', '"'].includes(quote)) out.push(null);
    else {
      const raw = text.slice(start, text.indexOf(quote, start));
      out.push(quote === '`' && raw.includes('${') ? null : normalizeSql(raw));
    }
  }
  return out;
}

describe('test-stand DB writes (P59)', () => {
  it('every fixtureWrite / holdRowLock call is a literal statement of the list; every entry is used', () => {
    const bad: string[] = [];
    const used = new Set<number>();
    for (const { file, text } of suites)
      for (const name of ['fixtureWrite', 'holdRowLock'])
        for (const sql of calls(text, name)) {
          const i = sql === null ? -1 : sanctionedIndex(sql);
          if (i < 0) bad.push(`${file}: ${name}: ${sql ?? '(non-literal SQL)'}`);
          else used.add(i);
        }
    expect(bad).toEqual([]);
    expect(SANCTIONED.filter((_, i) => !used.has(i)).map((s) => s.contract)).toEqual([]);
  });

  it('lib/db.ts enforces the list and plain reads at runtime', () => {
    const db = sources.find((s) => s.file === 'lib/db.ts')!.text;
    expect(db).toMatch(/default_transaction_read_only=on/);
    expect(db).toMatch(/export async function query[^{]*\{\s*assertRead\(sql\);/);
    expect(db).toMatch(
      /export async function fixtureWrite[\s\S]*?assertSanctioned\(sql\);[\s\S]*?writePool\.query/,
    );
    expect(db).toMatch(
      /export async function holdRowLock[\s\S]*?\): Promise<\{[^}]*\}> \{\s*assertSanctioned\(lockSql\);/,
    );
    // The bypasses of the final re-review (m3) are refused.
    for (const sql of [
      "UPDATE users SET status = 'ACTIVE', password_hash = 'x' WHERE id = $1",
      "UPDATE users SET status = 'ACTIVE' WHERE id = $1; DELETE FROM users",
      "UPDATE lab_tests SET due_at = now() - interval '1 second' WHERE id = $1 OR true",
      'SELECT id FROM indicators WHERE id = $1 FOR UPDATE; UPDATE indicators SET name = $2',
    ])
      expect(() => assertSanctioned(sql), sql).toThrow(/not a sanctioned/);
    for (const sql of [
      'BEGIN READ WRITE',
      'begin read write; update users set status = $1',
      'SET default_transaction_read_only = off',
      "SELECT set_config('default_transaction_read_only', 'off', false)",
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      'select id from users where id = $1 for\n  no key update',
      'SELECT 1; SELECT 2',
      'WITH x AS (UPDATE users SET status = $1 RETURNING id) SELECT * FROM x',
    ])
      expect(() => assertRead(sql), sql).toThrow(/not a plain read/);
    expect(() =>
      assertRead('SELECT id, updated_at, deleted_at, created_at FROM batches WHERE id = $1'),
    ).not.toThrow();
  });

  it('lib/db.ts is imported by name only, and no other file opens a database connection', () => {
    const bad: string[] = [];
    for (const { file, text } of suites) {
      for (const m of text.matchAll(/import\s*(type\s*)?\{([^}]*)\}\s*from\s*['"][./]*(lib\/)?db\.js['"]/g))
        if (/\bas\b/.test(m[2]!)) bad.push(`${file}: aliased import from lib/db.js`);
      if (/import\s*\*\s*as\s+\w+\s+from\s*['"][^'"]*db\.js['"]/.test(text))
        bad.push(`${file}: namespace import of lib/db.js`);
      if (/export\s*(\*|\{[^}]*\})\s*from\s*['"][^'"]*db\.js['"]/.test(text))
        bad.push(`${file}: re-export of lib/db.js`);
      // A function passed around under another name still runs its runtime check (lib/db.ts), so no value scan is
      // needed beyond the import forms above; they keep the call sites greppable by name.
      if (
        /(from|require\(|import\()\s*['"](pg|pg-pool|pg-promise|postgres|pg-native)['"]|new\s+pg\./.test(text)
      )
        bad.push(`${file}: opens a database connection`);
    }
    expect(bad).toEqual([]);
  });

  it('the contract names every sanctioned fixture', () => {
    expect(CONTRACT).toMatch(/Записи тестового стенда в общую БД \(P48, P51, P59\)/);
    expect(SANCTIONED.filter((s) => !CONTRACT.includes(s.contract)).map((s) => s.contract)).toEqual([]);
  });
});
