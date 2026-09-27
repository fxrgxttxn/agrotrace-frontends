// After `ng build` (production): every hashed JS/CSS/media file is under dist/assets/ (angular.json `browser:
// "assets"`, `deployUrl: "/assets/"`), where the gateway serves them with immutable caching and a 404 for a missing
// chunk (`location /assets/`, like the other frontends); index.html itself belongs at the root of dist/.
import { copyFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `--mock` (ruling FM23): the mock-mode build lives in dist-mock/ with the same layout.
const dist = join(
  dirname(fileURLToPath(import.meta.url)),
  process.argv.includes('--mock') ? '../dist-mock' : '../dist',
);
const from = join(dist, 'assets/index.html');
if (!existsSync(from)) throw new Error('postbuild: dist/assets/index.html not found');
renameSync(from, join(dist, 'index.html'));
if (process.argv.includes('--mock')) {
  // the shipped, unpatched MSW worker of @agrotrace/mock-api at the site root (its scope is the whole origin)
  const worker = join(
    dirname(fileURLToPath(import.meta.url)),
    '../node_modules/@agrotrace/mock-api/public/mockServiceWorker.js',
  );
  copyFileSync(worker, join(dist, 'mockServiceWorker.js'));
  console.log('postbuild: dist-mock/mockServiceWorker.js');
}
console.log(`postbuild: ${dist}/index.html, assets under assets/`);
