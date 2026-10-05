import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSchemaNames, renderAliasBlock, spliceAliasBlock } from '../scripts/alias-lib.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(PACKAGE_ROOT, 'node_modules', 'openapi-typescript', 'bin', 'cli.js');

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

describe('generated schema types (pnpm gen)', () => {
  it('src/schema.d.ts and the alias block in src/index.ts match the current contract', () => {
    execFileSync('pnpm', ['--filter', '@agrotrace/contracts', 'run', 'bundle'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });

    const dir = mkdtempSync(join(tmpdir(), 'agrotrace-api-client-schema-'));
    const bundledPath = join(REPO_ROOT, 'contracts', 'dist', 'openapi.json');
    const outPath = join(dir, 'schema.d.ts');

    try {
      execFileSync(process.execPath, [CLI, bundledPath, '-o', outPath], { cwd: PACKAGE_ROOT, stdio: 'pipe' });

      const freshSchema = normalize(readFileSync(outPath, 'utf8'));
      const committedSchema = normalize(readFileSync(join(PACKAGE_ROOT, 'src', 'schema.d.ts'), 'utf8'));
      expect(freshSchema).toBe(committedSchema);

      const names = extractSchemaNames(freshSchema);
      const freshBlock = renderAliasBlock(names);
      const committedIndex = normalize(readFileSync(join(PACKAGE_ROOT, 'src', 'index.ts'), 'utf8'));
      const expectedIndex = spliceAliasBlock(committedIndex, freshBlock);
      expect(committedIndex).toBe(expectedIndex);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
