import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as domain from '../src/index';

const dir = new URL('../../../contracts/rules/vectors/', import.meta.url);
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const v = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  describe(`${v.rule} (${f})`, () => {
    const fn = (domain as Record<string, unknown>)[v.fn] as (i: unknown) => unknown;
    it('function is exported', () => expect(typeof fn).toBe('function'));
    for (const c of v.cases) it(c.name, () => expect(fn(c.input)).toEqual(c.expected));
  });
}
