/**
 * Outbox write side (R55, P1): the row inserted in the caller's transaction carries the whole envelope, valid against
 * contracts/events/envelope.schema.json and the event's own schema; requestId comes from the request context.
 */
import { readFileSync, readdirSync } from 'node:fs';
import type { Transaction } from 'kysely';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { runWithContext } from '../src/context.js';
import type { DB } from '../src/db/types.generated.js';
import { enqueue } from '../src/infra/outbox.js';

const DIR = new URL('../../contracts/events/', import.meta.url);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(readFileSync(new URL(f, DIR), 'utf8')));

function fakeTx() {
  const inserts: { table: string; values: Record<string, unknown> }[] = [];
  const tx = {
    insertInto: (table: string) => ({
      values: (values: Record<string, unknown>) => ({
        execute: async () => {
          inserts.push({ table, values });
          return [];
        },
      }),
    }),
  } as unknown as Transaction<DB>;
  return { tx, inserts };
}

const vsdData = {
  documentId: '4e6a8c0e-2a4c-4e6a-8c0e-2a4c6e8a0c2e',
  batchId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c',
  publicCode: 'AT-2026-000123',
};

describe('outbox enqueue', () => {
  it('inserts one outbox_events row (backend express) whose payload is a valid envelope of the event', async () => {
    const { tx, inserts } = fakeTx();
    const env = await runWithContext({ requestId: 'req-42' }, () =>
      enqueue(tx, { type: 'vsd.import', payload: vsdData, now: () => new Date('2026-09-25T10:00:00.123Z') }),
    );
    expect(inserts).toHaveLength(1);
    const { table, values } = inserts[0]!;
    expect(table).toBe('outbox_events');
    expect(values).toMatchObject({ id: env.id, backend: 'express', type: 'vsd.import' });
    const payload = JSON.parse(values.payload as string);
    expect(payload).toEqual({
      id: env.id,
      type: 'vsd.import',
      occurredAt: '2026-09-25T10:00:00.123Z',
      backend: 'express',
      requestId: 'req-42',
      data: vsdData,
    });
    const validate = ajv.getSchema('https://agrotrace.local/contracts/events/vsd.import.schema.json')!;
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it('requestId is null outside a request (scheduler) and can be passed explicitly (worker)', async () => {
    const { tx, inserts } = fakeTx();
    const a = await enqueue(tx, { type: 'vsd.import', payload: vsdData });
    const b = await runWithContext({ requestId: 'req-1' }, () =>
      enqueue(tx, { type: 'vsd.import', payload: vsdData, requestId: 'from-event' }),
    );
    expect(a.requestId).toBeNull();
    expect(b.requestId).toBe('from-event');
    expect(new Set(inserts.map((i) => i.values.id)).size).toBe(2);
    const validate = ajv.getSchema('https://agrotrace.local/contracts/events/envelope.schema.json')!;
    expect(validate(JSON.parse(inserts[0]!.values.payload as string))).toBe(true);
  });
});
