import { describe, expect, it } from 'vitest';
import type { Rollup } from 'vite';
import { publicJs, PUBLIC_BUDGET_BYTES } from '../../vite-plugins/publicBudget';

const chunk = (fileName: string, o: Partial<Rollup.OutputChunk> = {}): Rollup.OutputChunk =>
  ({
    type: 'chunk',
    fileName,
    code: `/*${fileName}*/`,
    imports: [],
    dynamicImports: [],
    isEntry: false,
    isDynamicEntry: false,
    facadeModuleId: null,
    ...o,
  }) as unknown as Rollup.OutputChunk;
const asset = (fileName: string): Rollup.OutputAsset =>
  ({ type: 'asset', fileName, source: `/*${fileName}*/` }) as unknown as Rollup.OutputAsset;

function bundleOf(...items: (Rollup.OutputChunk | Rollup.OutputAsset)[]): Rollup.OutputBundle {
  return Object.fromEntries(items.map((i) => [i.fileName, i])) as Rollup.OutputBundle;
}

describe('public page JS (budget)', () => {
  const entry = chunk('assets/index-a.js', {
    isEntry: true,
    imports: ['assets/preload-x.js'],
    dynamicImports: ['assets/main-cabinet.js', 'assets/main-public.js'],
  });
  const pub = chunk('assets/main-public.js', {
    isDynamicEntry: true,
    facadeModuleId: '/repo/frontend-react/src/public/main.tsx',
    imports: ['assets/react-dom.js'],
    dynamicImports: ['assets/lazy-public.js'],
    code: 'new Worker(new URL("/assets/altcha.worker-z.js", import.meta.url))',
  });
  const bundle = bundleOf(
    entry,
    pub,
    chunk('assets/preload-x.js'),
    chunk('assets/react-dom.js'),
    chunk('assets/lazy-public.js', { imports: ['assets/react-dom.js'] }),
    chunk('assets/main-cabinet.js', {
      isDynamicEntry: true,
      imports: ['assets/react-dom.js', 'assets/big.js'],
    }),
    chunk('assets/big.js'),
    asset('assets/altcha.worker-z.js'),
    asset('assets/index.css'),
  );

  it('counts the entry, the public chunk, their imports, its lazy chunks and workers — not the cabinet', () => {
    const r = publicJs(bundle);
    expect(r.files.sort()).toEqual(
      [
        'assets/altcha.worker-z.js',
        'assets/index-a.js',
        'assets/lazy-public.js',
        'assets/main-public.js',
        'assets/preload-x.js',
        'assets/react-dom.js',
      ].sort(),
    );
    expect(r.gzipBytes).toBeGreaterThan(0);
  });

  it('fails without a public chunk (the check must never pass vacuously)', () => {
    expect(() => publicJs(bundleOf(entry))).toThrow(/public/);
  });

  it('the limit is 60 KB', () => {
    expect(PUBLIC_BUDGET_BYTES).toBe(60 * 1024);
  });
});
