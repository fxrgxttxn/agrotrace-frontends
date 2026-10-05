import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_REFRESH_AUTH_PATHS } from '../src/client';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface OpenapiOperation {
  security?: unknown[];
}

interface OpenapiDocument {
  paths: Record<string, Record<string, OpenapiOperation>>;
}

describe("R62: NO_REFRESH_AUTH_PATHS matches the contract's security: [] operations under /auth/", () => {
  it('derives the same set from contracts/dist/openapi.json', () => {
    execFileSync('pnpm', ['--filter', '@agrotrace/contracts', 'run', 'bundle'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });

    const contract = JSON.parse(
      readFileSync(join(REPO_ROOT, 'contracts', 'dist', 'openapi.json'), 'utf8'),
    ) as OpenapiDocument;

    const publicAuthPaths = new Set<string>();
    for (const [path, operations] of Object.entries(contract.paths)) {
      if (!path.startsWith('/auth/')) continue;
      for (const operation of Object.values(operations)) {
        if (Array.isArray(operation.security) && operation.security.length === 0) {
          publicAuthPaths.add(path);
        }
      }
    }

    expect(publicAuthPaths.size).toBeGreaterThan(0);
    expect(new Set(NO_REFRESH_AUTH_PATHS)).toEqual(publicAuthPaths);
  }, 30_000);
});
