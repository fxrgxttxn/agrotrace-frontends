import { readFileSync, writeFileSync } from 'node:fs';

interface StateMachine {
  statuses: string[];
  transitions: { from: string; to: string; action: string }[];
}

const smUrl = new URL('../rules/state-machine.json', import.meta.url);
const outUrl = new URL('../rules/vectors/state-machine.json', import.meta.url);

const sm: StateMachine = JSON.parse(readFileSync(smUrl, 'utf8'));
const allowed = new Set(sm.transitions.map((t) => `${t.from}->${t.to}`));

const cases: { name: string; input: { from: string; to: string }; expected: { allowed: boolean } }[] = [];

for (const from of sm.statuses) {
  for (const to of sm.statuses) {
    const isAllowed = allowed.has(`${from}->${to}`);
    cases.push({
      name: `${from} -> ${to} is ${isAllowed ? 'allowed' : 'not allowed'}`,
      input: { from, to },
      expected: { allowed: isAllowed },
    });
  }
}

const vector = { rule: 'state-machine', fn: 'canTransition', cases };

writeFileSync(outUrl, JSON.stringify(vector, null, 2) + '\n');

console.log(`Wrote ${cases.length} cases (${sm.statuses.length}^2) to ${outUrl.pathname}`);
