/** Health (contracts/openapi/paths/health.yaml) and the headers every response carries (spec 8.3, R79). */
import { describe, expect, it } from 'vitest';
import { api } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { API_BACKEND } from './lib/env.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('GET /health/live', () => {
  it('200 {status: ok} with X-Backend and X-Request-Id', async () => {
    const res = await api().get('/health/live');
    await expectContract(res, 'getHealthLive');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers.get('x-backend')).toBe(API_BACKEND);
  });
});

describe('GET /health/ready', () => {
  it('200 with every dependency ok (infra is up)', async () => {
    const res = await api().get('/health/ready');
    await expectContract(res, 'getHealthReady');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', checks: { db: 'ok', redis: 'ok', rabbitmq: 'ok', s3: 'ok' } });
  });
});

describe('X-Request-Id (R79)', () => {
  it('echoes a client id that matches ^[A-Za-z0-9._-]{1,64}$', async () => {
    for (const id of ['abc', 'A.b_c-9', 'x'.repeat(64), '4f1c2a7e-9b3d-4e5f-8a6b-0c1d2e3f4a5b']) {
      const res = await api().get('/health/live', { headers: { 'x-request-id': id } });
      await expectContract(res, 'getHealthLive');
      expect(res.headers.get('x-request-id')).toBe(id);
    }
  });

  it('replaces an id that does not match with a generated UUID', async () => {
    for (const id of ['x'.repeat(65), 'has space', 'semi;colon', 'slash/id', 'é', '']) {
      const res = await api().get('/health/live', { headers: { 'x-request-id': id } });
      await expectContract(res, 'getHealthLive');
      expect(res.headers.get('x-request-id')).toMatch(UUID_V4);
    }
  });

  it('generates a fresh UUID per request when none is sent', async () => {
    const [a, b] = await Promise.all([api().get('/health/live'), api().get('/health/live')]);
    expect(a.headers.get('x-request-id')).toMatch(UUID_V4);
    expect(b.headers.get('x-request-id')).toMatch(UUID_V4);
    expect(a.headers.get('x-request-id')).not.toBe(b.headers.get('x-request-id'));
  });

  it('is on error responses too', async () => {
    const res = await api().get('/no/such/path', { headers: { 'x-request-id': 'err-1' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-request-id')).toBe('err-1');
    expect(res.headers.get('x-backend')).toBe(API_BACKEND);
  });
});
