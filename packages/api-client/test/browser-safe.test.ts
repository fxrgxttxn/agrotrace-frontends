import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const files = readdirSync(srcDir, { recursive: true })
  .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts'))
  .sort();

describe('browser safety: no node: imports under src/', () => {
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

    it(`${f} does not import 'fs' or 'path', or use the process/Buffer Node APIs`, () => {
      const content = readFileSync(join(srcDir, f), 'utf8');
      expect(content).not.toMatch(/from\s+['"]fs['"]/);
      expect(content).not.toMatch(/from\s+['"]path['"]/);
      expect(content).not.toMatch(/require\(\s*['"](fs|path|process|buffer)['"]/);
      expect(content).not.toMatch(
        /\bprocess\.(env|argv|cwd|exit|platform|version|versions|stdout|stderr|stdin)\b/,
      );
      expect(content).not.toMatch(/\bBuffer\.(from|alloc|allocUnsafe|isBuffer|concat)\s*\(/);
      expect(content).not.toMatch(/\bnew\s+Buffer\s*\(/);
    });
  }
});
