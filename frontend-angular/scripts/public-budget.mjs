import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const PUBLIC_BUDGET_BYTES = 60 * 1024;

export function closure(outputs, start, lazy) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || !outputs[name]) return;
    seen.add(name);
    for (const i of outputs[name].imports ?? [])
      if (i.kind === 'import-statement' || (lazy && i.kind === 'dynamic-import')) visit(i.path);
  };
  visit(start);
  return [...seen];
}

const entryOf = (outputs, re) =>
  Object.keys(outputs).find((n) => n.endsWith('.js') && re.test(outputs[n].entryPoint ?? ''));

export function publicJs(entry, pub) {
  const main = entryOf(entry.outputs, /(^|\/)src\/main\.ts$/);
  const page = entryOf(pub.outputs, /(^|\/)src\/public\/main\.ts$/);
  if (!main || !page)
    throw new Error('public budget: no shared entry or no public main (src/public/main.ts)');
  const files = [
    ...closure(entry.outputs, main, false).map((f) => ({ file: f, bytes: entry.read(f) })),
    ...closure(pub.outputs, page, true).map((f) => ({ file: `p/${f}`, bytes: pub.read(f) })),
    ...Object.keys(pub.outputs)
      .filter((n) => n.endsWith('.js') && /\.worker\.ts$/.test(pub.outputs[n].entryPoint ?? ''))
      .map((f) => ({ file: `p/${f}`, bytes: pub.read(f) })),
  ];
  const sizes = Object.fromEntries(files.map((f) => [f.file, gzipSync(f.bytes, { level: 9 }).length]));
  return { files: Object.keys(sizes), sizes, gzipBytes: Object.values(sizes).reduce((a, b) => a + b, 0) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dist = join(root, process.argv.includes('--mock') ? 'dist-mock' : 'dist');
  const pubDir = join(root, 'dist-public');
  const stats = (dir) => JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8'));
  const readIn = (dir) => (f) =>
    readFileSync(existsSync(join(dir, f)) ? join(dir, f) : join(dir, 'assets', f));
  const r = publicJs(
    { outputs: stats(dist).outputs, read: readIn(dist) },
    { outputs: stats(pubDir).outputs, read: readIn(pubDir) },
  );
  const kb = (r.gzipBytes / 1024).toFixed(1);
  const line = `public QR page JS: ${kb} KB gzip of ${PUBLIC_BUDGET_BYTES / 1024} KB (${r.files.length} files)`;
  const detail = r.files.map((f) => `${f} ${(r.sizes[f] / 1024).toFixed(1)} KB`).join(', ');
  if (r.gzipBytes > PUBLIC_BUDGET_BYTES) {
    console.error(`${line} — over budget: ${detail}`);
    process.exit(1);
  }
  console.log(process.env.PUBLIC_BUDGET_DETAIL ? `${line}: ${detail}` : line);
}
