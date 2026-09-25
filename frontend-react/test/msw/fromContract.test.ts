import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { inject } from 'vitest';
import { server } from '../setup';
import {
  API_BASE,
  contractExample,
  contractResponse,
  operations,
  sampleFromSchema,
  type Json,
} from './fromContract';

// Ruling F1: component tests run on handlers generated from the contract. The generated answers must themselves be
// valid against the contract, or the tests would pass on data no backend can send.

function validator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  ajv.addFormat('binary', true);
  ajv.addSchema(inject('contract'), 'urn:agrotrace:openapi');
  return ajv;
}

describe('MSW handlers from contract examples', () => {
  it('cover every operation of the contract', () => {
    expect(operations().length).toBeGreaterThan(80);
  });

  it('every default (first 2xx) JSON answer is valid against its response schema', () => {
    const ajv = validator();
    const bad: string[] = [];
    for (const op of operations()) {
      if (op.operationId === 'streamEvents') continue;
      const spec = contractExample(op.operationId);
      if (!spec.mediaType || !/json/.test(spec.mediaType)) continue;
      const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
      const raw = op.op.responses[String(spec.status)] as Json;
      const base =
        typeof raw.$ref === 'string'
          ? (raw.$ref as string).slice(1)
          : `/paths/${esc(op.path)}/${op.method}/responses/${spec.status}`;
      const validate = ajv.compile({
        $ref: `urn:agrotrace:openapi#${base}/content/${esc(spec.mediaType)}/schema`,
      });
      if (!validate(spec.body)) bad.push(`${op.operationId}: ${ajv.errorsText(validate.errors)}`);
    }
    expect(bad).toEqual([]);
  });

  it('the default answer of an operation is served through fetch', async () => {
    const res = await fetch(`${API_BASE}/me`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(contractExample('getMe').body);
  });

  it('static paths win over parametrised ones', async () => {
    const res = await fetch(`${API_BASE}/me/channels`);
    expect(await res.json()).toEqual(contractExample('getMyChannels').body);
  });

  it('an override picks a declared status and a named example', async () => {
    server.use(contractResponse('login', { status: 401, example: 'accountLocked' }));
    const res = await fetch(`${API_BASE}/auth/login`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({
      code: 'ACCOUNT_LOCKED',
      params: { lockedUntil: '2026-09-24T08:45:00Z' },
    });
  });

  it('refuses a status the contract does not declare', () => {
    expect(() => contractResponse('getMe', { status: 418 })).toThrow(/not declared/);
    expect(() => contractResponse('login', { status: 200, example: 'nope' })).toThrow(/no example/);
  });

  it('synthesises from the schema when the contract has no example', () => {
    expect(
      sampleFromSchema({
        type: 'object',
        properties: { a: { type: 'string', format: 'uuid' }, b: { type: ['integer', 'null'], minimum: 1 } },
      }),
    ).toEqual({
      a: '00000000-0000-4000-8000-000000000001',
      b: 1,
    });
    expect(sampleFromSchema({ type: 'array', items: { enum: ['X', 'Y'] } })).toEqual(['X']);
  });
});
