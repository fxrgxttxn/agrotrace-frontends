import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Vitest turns asset imports into `/…` (inside the package) or `/@fs/<abs>` URLs; read them from disk. */
export async function nodeAssetLoader(url: string): Promise<Uint8Array> {
  const path = url.startsWith('/@fs/') ? url.slice(4) : join(ROOT, url.split('?')[0]!);
  return new Uint8Array(await readFile(decodeURIComponent(path)));
}
