import { describe, expect, it } from 'vitest';
import { server } from '../setup';
import {
  API_BASE,
  contractExample,
  contractResponse,
  operations,
  responseSchemaErrors,
  sampleFromSchema,
} from './fromContract';

describe('MSW handlers from contract examples', () => {
  it('cover every operation of the contract', () => {
    expect(operations().length).toBeGreaterThan(80);
  });

  it('every default (first 2xx) JSON answer is valid against its response schema', () => {
    const bad: string[] = [];
    for (const op of operations()) {
      if (op.operationId === 'streamEvents') continue;
      const spec = contractExample(op.operationId);
      if (!spec.mediaType || !/json/.test(spec.mediaType)) continue;
      const errors = responseSchemaErrors(op.operationId, spec.status, spec.mediaType, spec.body);
      if (errors.length) bad.push(`${op.operationId}: ${errors.join('; ')}`);
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

  it('refuses an explicit body the schema does not allow, accepts a valid one', () => {
    expect(() =>
      contractResponse('getMe', { body: { ...(contractExample('getMe').body as object), roles: [] } }),
    ).toThrow(/does not match the contract/);
    expect(() => contractResponse('login', { status: 401, body: { code: 'INVALID_CREDENTIALS' } })).toThrow(
      /does not match the contract/,
    );
    expect(() =>
      contractResponse('getMe', { body: { ...(contractExample('getMe').body as object), roles: ['LAB'] } }),
    ).not.toThrow();
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
