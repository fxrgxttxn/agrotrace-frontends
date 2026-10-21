/**
 * Lock strengths (R52, P57): every explicit row lock taken to change non-key columns is `FOR NO KEY UPDATE`, so the
 * `FOR KEY SHARE` that PostgreSQL takes on a parent row for each insert/update of a referencing row never waits for
 * it (final review I2: confirmRecallTask ∥ submitLabResults deadlocked through `lab_tests.recall_id`). `FOR UPDATE`
 * stays only where the conflict with FOR KEY SHARE is wanted, each listed here with its reason; a new `FOR UPDATE`
 * anywhere else fails this guard. tests/api/locks.test.ts reproduces the I2 pair over HTTP.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

/** file → number of deliberate `FOR UPDATE` locks in it (code, not comments). */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'modules/dictionaries/store.ts': { count: 1, why: 'hard delete of a dictionary row (P23)' },
  'modules/fields/service.ts': {
    count: 1,
    why: 'deleteField: the soft delete must wait for and exclude FOR KEY SHARE references (createBatch, treatments)',
  },
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith('.ts') && !p.endsWith('types.generated.ts') ? [p] : [];
  });
}

/** The source without comments (block and line comments; strings are left alone, good enough for this scan). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('lock strengths (P57)', () => {
  it('FOR UPDATE only where a conflict with FOR KEY SHARE is intended', () => {
    const found: Record<string, number> = {};
    for (const f of files(SRC)) {
      const src = code(readFileSync(f, 'utf8'));
      const n = (src.match(/\.forUpdate\(/g)?.length ?? 0) + (src.match(/\bFOR UPDATE\b/g)?.length ?? 0);
      if (n > 0) found[relative(SRC, f).replaceAll('\\', '/')] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, v.count])));
  });

  it('the R52 row locks (waybill, batches, recall tasks) are FOR NO KEY UPDATE', () => {
    const locks = code(readFileSync(join(SRC, 'db', 'locks.ts'), 'utf8'));
    expect(locks.match(/\.forNoKeyUpdate\(\)/g)?.length).toBe(3);
  });
});
