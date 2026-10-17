import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(
  dirname(fileURLToPath(import.meta.url)),
  process.argv.includes('--mock') ? '../dist-mock' : '../dist',
);
const from = join(dist, 'assets/index.html');
if (!existsSync(from)) throw new Error('postbuild: dist/assets/index.html not found');
renameSync(from, join(dist, 'index.html'));
const base = (process.env.AT_BASE_PATH ?? '').replace(/^\/+|\/+$/g, '');
if (base) {
  const index = join(dist, 'index.html');
  const html = readFileSync(index, 'utf8');
  if (!html.includes('</title>')) throw new Error('postbuild: no </title> in index.html');
  writeFileSync(index, html.replace('</title>', `</title>\n    <meta name="at-base" content="/${base}" />`));
  console.log(`postbuild: base /${base}/`);
}
if (process.argv.includes('--mock')) {
  const worker = join(
    dirname(fileURLToPath(import.meta.url)),
    '../node_modules/@agrotrace/mock-api/public/mockServiceWorker.js',
  );
  copyFileSync(worker, join(dist, 'mockServiceWorker.js'));
  console.log('postbuild: dist-mock/mockServiceWorker.js');
}
console.log(`postbuild: ${dist}/index.html, assets under assets/`);
