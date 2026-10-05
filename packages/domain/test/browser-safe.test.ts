import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(srcDir, { recursive: true })
  .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts'))
  .sort();

describe('browser safety (R2): no node: imports under src/', () => {
  it('found source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f} does not import a node: builtin`, () => {
      const content = readFileSync(join(srcDir, f), 'utf8');
      expect(content).not.toMatch(/from\s+['"]node:/);
      expect(content).not.toMatch(/require\(\s*['"]node:/);
      expect(content).not.toMatch(/import\(\s*['"]node:/);
    });
  }
});
