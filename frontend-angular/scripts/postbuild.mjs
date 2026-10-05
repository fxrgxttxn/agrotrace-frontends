import { copyFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(
  dirname(fileURLToPath(import.meta.url)),
  process.argv.includes('--mock') ? '../dist-mock' : '../dist',
);
const from = join(dist, 'assets/index.html');
if (!existsSync(from)) throw new Error('postbuild: dist/assets/index.html not found');
renameSync(from, join(dist, 'index.html'));
if (process.argv.includes('--mock')) {
  const worker = join(
    dirname(fileURLToPath(import.meta.url)),
    '../node_modules/@agrotrace/mock-api/public/mockServiceWorker.js',
  );
  copyFileSync(worker, join(dist, 'mockServiceWorker.js'));
  console.log('postbuild: dist-mock/mockServiceWorker.js');
}
console.log(`postbuild: ${dist}/index.html, assets under assets/`);
