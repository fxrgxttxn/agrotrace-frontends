import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020';

const rulesDir = new URL('../rules/', import.meta.url);
const dir = new URL('../rules/vectors/', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('vector.schema.json', rulesDir), 'utf8'));
const validate = new Ajv({ allErrors: true }).compile(schema);
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

const EXPECTED: Record<string, { rule: string; fn: string }> = {
  'state-machine.json': { rule: 'state-machine', fn: 'canTransition' },
  'BR-01.json': { rule: 'BR-01', fn: 'checkWaitingPeriod' },
  'BR-02.json': { rule: 'BR-02', fn: 'concludeLabTest' },
  'BR-03.json': { rule: 'BR-03', fn: 'requiresLabTest' },
  'BR-04.json': { rule: 'BR-04', fn: 'checkMassBalance' },
  'BR-05.json': { rule: 'BR-05', fn: 'canUseAsInput' },
  'BR-07.json': { rule: 'BR-07', fn: 'checkDiscrepancy' },
  'BR-08.json': { rule: 'BR-08', fn: 'recallTaskDueAt' },
  'BR-08-overdue.json': { rule: 'BR-08', fn: 'isOverdue' },
  'BR-09.json': { rule: 'BR-09', fn: 'nextTrustRating' },
  'BR-10.json': { rule: 'BR-10', fn: 'shouldCloseRecall' },
  'BR-11.json': { rule: 'BR-11', fn: 'idempotencyDecision' },
  'batch-code.json': { rule: 'BATCH-CODE', fn: 'formatBatchCode' },
  'working-days.json': { rule: 'WORKING-DAYS', fn: 'addWorkingDays' },
  'treatment-edit.json': { rule: 'TREATMENT-EDIT', fn: 'canEditTreatment' },
};

interface StateMachine {
  statuses: string[];
  transitions: { from: string; to: string; action: string }[];
}

describe('rule vectors', () => {
  it('ships exactly one vector file per expected (rule, fn) pair - no missing, no extra files', () => {
    expect(new Set(files)).toEqual(new Set(Object.keys(EXPECTED)));
  });

  for (const f of files) {
    it(`${f} matches schema, has unique case names, and declares its expected rule/fn`, () => {
      const v = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      expect(validate(v), JSON.stringify(validate.errors)).toBe(true);
      const names = v.cases.map((c: { name: string }) => c.name);
      expect(new Set(names).size).toBe(names.length);
      if (EXPECTED[f]) {
        expect({ rule: v.rule, fn: v.fn }).toEqual(EXPECTED[f]);
      }
    });
  }

  it('state-machine.json vectors are exactly the statuses^2 pairs generated from state-machine.json', () => {
    const sm: StateMachine = JSON.parse(readFileSync(new URL('state-machine.json', rulesDir), 'utf8'));
    const allowed = new Set(sm.transitions.map((t) => `${t.from}->${t.to}`));
    const expectedCases: {
      name: string;
      input: { from: string; to: string };
      expected: { allowed: boolean };
    }[] = [];
    for (const from of sm.statuses) {
      for (const to of sm.statuses) {
        const isAllowed = allowed.has(`${from}->${to}`);
        expectedCases.push({
          name: `${from} -> ${to} is ${isAllowed ? 'allowed' : 'not allowed'}`,
          input: { from, to },
          expected: { allowed: isAllowed },
        });
      }
    }
    const actual = JSON.parse(readFileSync(new URL('state-machine.json', dir), 'utf8'));
    expect(actual.cases).toEqual(expectedCases);
  });
});
