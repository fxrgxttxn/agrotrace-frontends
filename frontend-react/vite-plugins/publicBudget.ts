import { gzipSync } from 'node:zlib';
import type { Plugin, Rollup } from 'vite';
type OutputBundle = Rollup.OutputBundle;
type OutputChunk = Rollup.OutputChunk;

export const PUBLIC_BUDGET_BYTES = 60 * 1024;
const PUBLIC_MODULE = /[\\/]src[\\/]public[\\/]main\.tsx$/;

export interface PublicJs {
  files: string[];
  gzipBytes: number;
  sizes: Record<string, number>;
}

const gzipSize = (code: string | Uint8Array) => gzipSync(code, { level: 9 }).length;

export function publicJs(bundle: OutputBundle): PublicJs {
  const chunks = new Map<string, OutputChunk>();
  for (const item of Object.values(bundle)) if (item.type === 'chunk') chunks.set(item.fileName, item);
  const entry = [...chunks.values()].find((c) => c.isEntry);
  const pub = [...chunks.values()].find((c) => c.facadeModuleId && PUBLIC_MODULE.test(c.facadeModuleId));
  if (!entry || !pub)
    throw new Error('public budget: no entry or no public chunk (src/public/main.tsx) in the bundle');

  const seen = new Set<string>();
  const visit = (name: string, lazy: boolean) => {
    if (seen.has(name)) return;
    const c = chunks.get(name);
    if (!c) return;
    seen.add(name);
    c.imports.forEach((n) => visit(n, lazy));
    if (lazy) c.dynamicImports.forEach((n) => visit(n, lazy));
  };
  visit(entry.fileName, false);
  visit(pub.fileName, true);

  const files = [...seen];
  const sizes: Record<string, number> = {};
  for (const f of files) sizes[f] = gzipSize(chunks.get(f)!.code);
  for (const item of Object.values(bundle)) {
    if (item.type !== 'asset' || !item.fileName.endsWith('.js')) continue;
    const base = item.fileName.split('/').pop()!;
    if (files.some((f) => chunks.get(f)!.code.includes(base))) {
      files.push(item.fileName);
      sizes[item.fileName] = gzipSize(item.source);
    }
  }
  const gzipBytes = Object.values(sizes).reduce((a, b) => a + b, 0);
  return { files, gzipBytes, sizes };
}

export function publicBudget(): Plugin {
  return {
    name: 'agrotrace-public-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      const r = publicJs(bundle);
      if (process.env.PUBLIC_BUDGET_DETAIL)
        for (const f of r.files) {
          const c = bundle[f];
          if (c?.type !== 'chunk') continue;
          const mods = Object.entries(c.modules).sort((a, b) => b[1].renderedLength - a[1].renderedLength);
          for (const [id, info] of mods.slice(0, 30))
            console.log(`${f}\t${info.renderedLength}\t${id.replace(/^.*node_modules\//, '').slice(-80)}`);
        }
      const kb = (r.gzipBytes / 1024).toFixed(1);
      const line = `public QR page JS: ${kb} KB gzip of ${PUBLIC_BUDGET_BYTES / 1024} KB (${r.files.length} files)`;
      if (r.gzipBytes > PUBLIC_BUDGET_BYTES)
        this.error(
          `${line} — over budget: ${r.files.map((f) => `${f} ${(r.sizes[f]! / 1024).toFixed(1)} KB`).join(', ')}`,
        );
      console.log(line);
    },
  };
}
