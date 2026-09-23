import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020';

const dir = new URL('../rules/vectors/', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('../rules/vector.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: true }).compile(schema);
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('rule vectors', () => {
  it('cover every business rule', () => {
    for (const r of [
      'BR-01',
      'BR-02',
      'BR-03',
      'BR-04',
      'BR-05',
      'BR-07',
      'BR-08',
      'BR-08-overdue',
      'BR-09',
      'BR-10',
      'BR-11',
      'state-machine',
    ])
      expect(files).toContain(`${r}.json`);
  });
  for (const f of files) {
    it(`${f} matches schema and has unique case names`, () => {
      const v = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      expect(validate(v), JSON.stringify(validate.errors)).toBe(true);
      const names = v.cases.map((c: { name: string }) => c.name);
      expect(new Set(names).size).toBe(names.length);
    });
  }
});
