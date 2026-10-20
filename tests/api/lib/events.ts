/**
 * Queue documents against contracts/events/*.schema.json (R55): every outbox row a test reads (lib/db.ts
 * outboxEvents) must be a valid envelope of its type — `occurredAt`, `backend`, `requestId` and `data` included — so
 * an envelope drift in any backend fails the suite, not only the fields a test happens to assert.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const DIR = fileURLToPath(new URL('../../../contracts/events/', import.meta.url));
const BASE = 'https://agrotrace.local/contracts/events/';

let validators: Map<string, ValidateFunction> | null = null;

function load(): Map<string, ValidateFunction> {
  if (validators) return validators;
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  const files = readdirSync(DIR).filter((f) => f.endsWith('.schema.json'));
  for (const f of files) ajv.addSchema(JSON.parse(readFileSync(`${DIR}${f}`, 'utf8')) as object);
  validators = new Map(
    files
      .filter((f) => f !== 'envelope.schema.json')
      .map((f) => [f.replace('.schema.json', ''), ajv.getSchema(`${BASE}${f}`)!]),
  );
  return validators;
}

/** Throws unless `doc` is a valid queue document of its `type`. */
export function assertEvent(doc: { type?: unknown }): void {
  const v = load().get(String(doc.type));
  if (!v) throw new Error(`outbox event of unknown type ${String(doc.type)}`);
  if (!v(doc))
    throw new Error(`outbox event violates its schema: ${JSON.stringify(v.errors)}\n${JSON.stringify(doc)}`);
}
