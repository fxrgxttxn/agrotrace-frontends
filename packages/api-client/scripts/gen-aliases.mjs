// Regenerates the "GENERATED SCHEMA ALIASES" block inside src/index.ts from src/schema.d.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractSchemaNames, renderAliasBlock, spliceAliasBlock } from './alias-lib.mjs';

const schemaPath = fileURLToPath(new URL('../src/schema.d.ts', import.meta.url));
const indexPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));

const schemaSource = readFileSync(schemaPath, 'utf8');
const names = extractSchemaNames(schemaSource);
const block = renderAliasBlock(names);

const indexSource = readFileSync(indexPath, 'utf8');
writeFileSync(indexPath, spliceAliasBlock(indexSource, block));
