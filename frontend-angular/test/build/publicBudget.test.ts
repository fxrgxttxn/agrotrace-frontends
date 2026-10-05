import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs build script without type declarations
import { publicJs, PUBLIC_BUDGET_BYTES } from '../../scripts/public-budget.mjs';

type Imp = { path: string; kind: 'import-statement' | 'dynamic-import' };
const out = (entryPoint: string | undefined, imports: Imp[] = []) => ({ entryPoint, imports });
const stat = (path: string): Imp => ({ path, kind: 'import-statement' });
const lazy = (path: string): Imp => ({ path, kind: 'dynamic-import' });
const read = (f: string) => Buffer.from(`/*${f}*/`);

const entry = {
  outputs: {
    'main-a.js': out('src/main.ts', [stat('chunk-x.js'), lazy('chunk-cabinet.js')]),
    'chunk-x.js': out(undefined),
    'chunk-cabinet.js': out(undefined, [stat('chunk-big.js')]),
    'chunk-big.js': out(undefined),
    'styles.css': out(undefined),
  },
  read,
};
const pub = {
  outputs: {
    'main-p.js': out('src/public/main.ts', [stat('chunk-core.js'), lazy('chunk-lazy.js')]),
    'chunk-core.js': out(undefined),
    'chunk-lazy.js': out(undefined, [stat('chunk-core.js')]),
    'worker-z.js': out('src/public/altcha.worker.ts'),
  },
  read,
};

describe('public page JS (budget)', () => {
  it('counts the entry and its imports, the public main, its imports, its lazy chunks and workers — not the cabinet', () => {
    const r = publicJs(entry, pub);
    expect([...r.files].sort()).toEqual(
      [
        'chunk-x.js',
        'main-a.js',
        'p/chunk-core.js',
        'p/chunk-lazy.js',
        'p/main-p.js',
        'p/worker-z.js',
      ].sort(),
    );
    expect(r.gzipBytes).toBeGreaterThan(0);
  });

  it('fails without a public main (the check must never pass vacuously)', () => {
    expect(() => publicJs(entry, { outputs: {}, read })).toThrow(/public/);
  });

  it('the limit is 60 KB', () => {
    expect(PUBLIC_BUDGET_BYTES).toBe(60 * 1024);
  });
});
