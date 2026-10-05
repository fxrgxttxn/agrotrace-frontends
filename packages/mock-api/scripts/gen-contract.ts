import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { operationTable } from './contract-table.js';

const out = fileURLToPath(new URL('../src/contract/operations.generated.ts', import.meta.url));
const table = await operationTable();
writeFileSync(
  out,
  [
    "import type { OperationMeta } from './types.js';",
    '',
    `export const OPERATIONS: readonly OperationMeta[] = ${JSON.stringify(table, null, 2)};`,
    '',
  ].join('\n'),
);
console.log(`operations: ${table.length}`);
