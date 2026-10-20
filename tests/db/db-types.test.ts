/**
 * The Express backend's Kysely types (backend-express/src/db/types.generated.ts, `./at.sh gen:db-types`) describe
 * exactly the schema the migrations produce: they are regenerated from this freshly migrated test database into a
 * temporary file and compared byte for byte (kysely-codegen's own --verify exits 0 even on a mismatch).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const COMMITTED = join(REPO, 'backend-express/src/db/types.generated.ts');

describe('backend-express Kysely types (gen:db-types)', () => {
  it('are up to date with the migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-types-'));
    try {
      const out = join(dir, 'types.generated.ts');
      // The package's own gen:db-types script with its flags; only the output path (DB_TYPES_OUT) differs.
      // DATABASE_URL = this suite's migrated agrotrace_test (./at.sh db:test).
      const r = spawnSync('pnpm', ['--filter', '@agrotrace/backend-express', 'run', 'gen:db-types'], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, DB_TYPES_OUT: out },
      });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(readFileSync(out, 'utf8'), 'run ./at.sh gen:db-types and commit the result').toBe(
        readFileSync(COMMITTED, 'utf8'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
