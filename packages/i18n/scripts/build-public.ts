// Writes public/<locale>.json — the projection of each full dictionary on PUBLIC_KEYS (ruling FM35). Run with
// `pnpm --filter @agrotrace/i18n build:public` after changing the keys or their texts; the result is committed and
// test/public.test.ts fails when it is stale.
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
