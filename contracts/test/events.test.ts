import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

// Queue event JSON Schemas (spec 8.2.1, contracts/events/*.schema.json).
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
      ['recall.requested.schema.json', { ...base, type: 'recall.requested' }], // no data
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
