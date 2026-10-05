import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPublic } from '../src/public-keys.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'public'), { recursive: true });
for (const locale of ['ru', 'en']) {
  const full = JSON.parse(readFileSync(join(root, 'locales', `${locale}.json`), 'utf8'));
  writeFileSync(join(root, 'public', `${locale}.json`), `${JSON.stringify(pickPublic(full), null, 2)}\n`);
}
