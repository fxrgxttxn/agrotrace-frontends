// After `ng build` (production): every hashed JS/CSS/media file is under dist/assets/ (angular.json `browser:
// "assets"`, `deployUrl: "/assets/"`), where the gateway serves them with immutable caching and a 404 for a missing
// chunk (`location /assets/`, like the other frontends); index.html itself belongs at the root of dist/.
import { existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '../dist');
const from = join(dist, 'assets/index.html');
if (!existsSync(from)) throw new Error('postbuild: dist/assets/index.html not found');
renameSync(from, join(dist, 'index.html'));
console.log('postbuild: dist/index.html, assets under dist/assets/');
