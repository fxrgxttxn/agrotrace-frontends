import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

type Json = Record<string, any>;

const DIR = new URL('../events/', import.meta.url);
const read = (name: string): Json => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));
const EVENT_FILES = readdirSync(DIR).filter(
  (f) => f.endsWith('.schema.json') && f !== 'envelope.schema.json',
);
const NOTIFICATIONS = JSON.parse(
  readFileSync(new URL('../rules/notifications.json', import.meta.url), 'utf8'),
);

let ajv: Ajv2020;
beforeAll(() => {
  ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
  addFormats(ajv);
  ajv.addSchema(read('envelope.schema.json'));
  for (const f of EVENT_FILES) ajv.addSchema(read(f));
});

const validator = (f: string) => ajv.getSchema(read(f).$id)!;

const base = {
  id: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
  occurredAt: '2026-09-24T09:00:00Z',
  backend: 'express',
  requestId: null,
};

describe('queue events', () => {
  it('there is exactly one schema per envelope event type, named <type>.schema.json', () => {
    const types: string[] = read('envelope.schema.json').properties.type.enum;
    expect(EVENT_FILES.map((f) => f.replace('.schema.json', '')).sort()).toEqual([...types].sort());
    for (const f of EVENT_FILES) {
      const s = read(f);
      expect(s.properties.type.const, f).toBe(f.replace('.schema.json', ''));
      expect(s.$id, f).toBe(`https://agrotrace.local/contracts/events/${f}`);
      expect(s.allOf, f).toEqual([{ $ref: 'envelope.schema.json' }]);
      expect(s.properties.data.additionalProperties, f).toBe(false);
    }
  });

  it('worker concurrency: prefetch 1 per channel, one vsd.import at a time, other types never starved (R92)', () => {
    const d: string = read('envelope.schema.json').description;
    expect(d).toMatch(/Worker concurrency \(R92\)/);
    expect(d).toMatch(/two channels, each with basic\.qos prefetch 1/);
    expect(d).toMatch(/at most ONE `vsd\.import` handler at a time/);
    expect(d).toMatch(/basic\.nack requeue=true/);
    expect(read('vsd.import.schema.json').description).toMatch(
      /At most one vsd\.import handler runs per worker process[^.]*R92/,
    );
  });

  it('consumer idempotency uses processed_events, never a payload lookup (R56); retention and occurredAt (R59)', () => {
    const env: string = read('envelope.schema.json').description;
    expect(env).toMatch(/INSERT INTO processed_events[^.]*ON CONFLICT DO NOTHING/);
    expect(env).toMatch(/0 rows/);
    expect(env).toMatch(
      /publish[^.]*then[^.]*UPDATE outbox_events SET published_at[^.]*WHERE[^.]*published_at IS NULL/,
    );
    expect(env).toMatch(/7 days/);
    expect(env).toMatch(/30 days/);
    expect(env).toMatch(/stopped/);
    expect(read('envelope.schema.json').properties.occurredAt.description).toMatch(/outbox_events/);
    for (const f of [...EVENT_FILES, 'envelope.schema.json'])
      expect(JSON.stringify(read(f)), f).not.toMatch(/payload->>'eventId'|eventId/);
  });

  it('notification.dispatch enforces the payload keys of each type (R59)', () => {
    const s = read('notification.dispatch.schema.json');
    const rules = (s.properties.data.allOf as Json[]).map((r) => [
      r.if.properties.notificationType.const,
      [...r.then.properties.payload.required].sort(),
      Object.keys(r.then.properties.payload.properties).sort(),
    ]);
    for (const r of s.properties.data.allOf as Json[])
      expect(r.then.properties.payload.additionalProperties).toBe(false);
    expect(rules.map((r) => r[0])).toEqual(Object.keys(NOTIFICATIONS.types));
    for (const [type, required, names] of rules) {
      const keys = [...NOTIFICATIONS.types[type].payload].sort();
      expect(required, type).toEqual(keys);
      expect(names, type).toEqual(keys);
    }
    const v = validator('notification.dispatch.schema.json');
    const ok = structuredClone(s.examples[0]);
    const extra = structuredClone(ok);
    extra.data.payload.foo = 1;
    const missing = structuredClone(ok);
    delete missing.data.payload.number;
    expect(v(ok)).toBe(true);
    expect(v(extra)).toBe(false);
    expect(v(missing)).toBe(false);
  });

  it('vsd.import (R81): Mercury query, CONFIRMED pick, 5 retries 2…32 s then FAILED, never blocks the batch', () => {
    const d: string = read('vsd.import.schema.json').description;
    expect(d).toMatch(/createBatch[^.]*DAIRY or MEAT/);
    expect(d).toMatch(/retryBatchVsdImport/);
    expect(d).toMatch(/productCode = products\.mercury_code/);
    expect(d).toMatch(/senderInn = organizations\.inn of the batch origin/);
    expect(d).toMatch(/harvested_at − 3 days and harvested_at \+ 3 days/);
    expect(d).toMatch(/status CONFIRMED it picks the latest/);
    expect(d).toMatch(/2, 4, 8, 16 and 32 s \(5 retries/);
    expect(d).toMatch(/FAILED/);
    expect(d).toMatch(/NOT_FOUND/);
    expect(d).toMatch(/never changed or blocked/);
    expect(d).toMatch(/processed_events claim/);
  });

  it('every schema example is valid', () => {
    const bad: string[] = [];
    for (const f of EVENT_FILES) {
      const examples: unknown[] = read(f).examples ?? [];
      if (!examples.length) bad.push(`${f}: no examples`);
      const v = validator(f);
      examples.forEach((e, i) => {
        if (!v(e)) bad.push(`${f}[${i}]: ${ajv.errorsText(v.errors)}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('notification.dispatch examples carry exactly the payload keys of rules/notifications.json', () => {
    const s = read('notification.dispatch.schema.json');
    expect(s.properties.data.properties.notificationType.enum).toEqual(Object.keys(NOTIFICATIONS.types));
    for (const e of s.examples as Json[]) {
      const keys = Object.keys(e.data.payload).sort();
      expect(keys, e.data.notificationType).toEqual(
        [...NOTIFICATIONS.types[e.data.notificationType].payload].sort(),
      );
    }
  });

  it('rejects malformed events', () => {
    const cases: [string, unknown][] = [
      ['recall.requested.schema.json', { ...base, type: 'recall.requested' }],
      [
        'recall.requested.schema.json',
        {
          ...base,
          type: 'lab.escalate',
          data: {
            recallId: '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d',
            sourceBatchId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c',
            trigger: 'LAB',
            openedBy: null,
          },
        },
      ],
      [
        'recall.requested.schema.json',
        {
          ...base,
          type: 'recall.requested',
          extra: 1,
          data: {
            recallId: '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d',
            sourceBatchId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c',
            trigger: 'LAB',
            openedBy: null,
          },
        },
      ],
      [
        'notification.dispatch.schema.json',
        {
          ...base,
          type: 'notification.dispatch',
          data: {
            notificationType: 'COMPLAINT',
            recipients: { userIds: [], orgIds: [], orgHeadIds: [], roles: [] },
            payload: {},
          },
        },
      ],
      [
        'notification.dispatch.schema.json',
        {
          ...base,
          type: 'notification.dispatch',
          data: {
            notificationType: 'COMPLAINT',
            recipients: { userIds: [], orgIds: [], orgHeadIds: [], roles: ['INSPECTOR'] },
            payload: { eventId: 'x' },
          },
        },
      ],
      [
        'lab.escalate.schema.json',
        {
          ...base,
          type: 'lab.escalate',
          requestId: '4f1c2a7e-9b3d-4e5f-8a6b-0c1d2e3f4a5b',
          data: {
            labTestId: '8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e',
            labOrgId: '5a7c9e1b-3d5f-4a7c-9e1b-3d5f7a9c1e3b',
            batchId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c',
            publicCode: 'AT-2026-000123',
            dueAt: '2026-08-01T09:00:00Z',
            escalatedAt: '2026-08-01T09:05:00Z',
          },
        },
      ],
      [
        'vsd.import.schema.json',
        {
          ...base,
          type: 'vsd.import',
          data: {
            documentId: '4e6a8c0e-2a4c-4e6a-8c0e-2a4c6e8a0c2e',
            batchId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c',
            publicCode: 'AT-2026-000123',
            productCode: '10.51.11',
          },
        },
      ],
      [
        'vsd.import.schema.json',
        {
          ...base,
          type: 'vsd.import',
          data: {
            documentId: '4e6a8c0e-2a4c-4e6a-8c0e-2a4c6e8a0c2e',
            batchId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c',
          },
        },
      ],
      [
        'rating.recalculate.schema.json',
        {
          ...base,
          backend: 'go',
          type: 'rating.recalculate',
          data: {
            organizationId: '0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10',
            cause: 'LAB_FAIL',
            sourceId: '8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e',
          },
        },
      ],
    ];
    const accepted = cases.filter(([f, e]) => validator(f)(e)).map(([f, e]) => `${f}: ${JSON.stringify(e)}`);
    expect(accepted).toEqual([]);
  });
});
