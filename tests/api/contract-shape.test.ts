/**
 * Cross-cutting response shape (info.description, spec 8.3): every error is an RFC 7807 problem of the contract's
 * `Problem` schema with `type` = /problems/<kebab-code>, and X-Backend/X-Request-Id — also for requests no operation
 * handles.
 */
import { describe, expect, it } from 'vitest';
import { api } from './lib/client.js';
import { expectContract, expectProblem, expectSharedResponse } from './lib/contract.js';

const MAX_BODY = 12 * 1024 * 1024; // the gateway's client_max_body_size (R79)

describe('paths and methods outside the contract', () => {
  it('unknown path → 404 NOT_FOUND problem', async () => {
    for (const [method, path] of [
      ['GET', '/no/such/path'],
      ['POST', '/no/such/path'],
      ['GET', '/health'],
      ['GET', '/health/live/extra'],
    ] as const) {
      const res = await api().request(method, path);
      await expectProblem(res, 404, 'NOT_FOUND');
    }
  });

  it('a path outside /api/v1 → 404 NOT_FOUND problem', async () => {
    const res = await api().request('GET', '/../../nope');
    await expectProblem(res, 404, 'NOT_FOUND');
  });

  it('a contract path with a method it does not declare → 405 METHOD_NOT_ALLOWED with Allow (P3)', async () => {
    for (const [method, path, allow] of [
      ['DELETE', '/health/live', 'GET'],
      ['POST', '/health/ready', 'GET'],
      ['GET', '/auth/login', 'POST'],
      ['PATCH', '/batches/8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e', 'GET'],
    ] as const) {
      const res = await api().request(method, path);
      await expectSharedResponse(res, 'MethodNotAllowed', { status: 405, code: 'METHOD_NOT_ALLOWED' });
      expect(res.headers.get('allow'), path).toBe(allow);
    }
  });
});

describe('request bodies', () => {
  it('malformed JSON → 400 VALIDATION problem (errors at the body root)', async () => {
    const res = await api().post('/auth/login', '{"email": "a@b.ru", ', {
      headers: { 'content-type': 'application/json' },
    });
    await expectContract(res, 'login');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION',
      type: '/problems/validation',
      errors: { _root: ['validation.invalid'] },
    });
  });

  it('a JSON body larger than 12 MiB → 413 FILE_TOO_LARGE problem with params.maxBytes', async () => {
    const body = JSON.stringify({ email: 'a@b.ru', password: 'x'.repeat(MAX_BODY) });
    const res = await api().post('/auth/login', body, { headers: { 'content-type': 'application/json' } });
    await expectProblem(res, 413, 'FILE_TOO_LARGE');
    expect(res.body.params).toEqual({ maxBytes: MAX_BODY });
  });
});
