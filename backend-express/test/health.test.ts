/**
 * getHealthReady's 503 (a dependency down) cannot be provoked against the live stack in tests/api; here each probe
 * fails or hangs in turn and the response is checked against the contract's 503 schema.
 */
import request from 'supertest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { fakeContainer, testContract, type Probes } from './helpers.js';

let validate503: (v: unknown) => boolean;
let validate200: (v: unknown) => boolean;

beforeAll(async () => {
  const { doc } = await testContract();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(doc, 'urn:agrotrace:c');
  const ptr = (code: string) =>
    `urn:agrotrace:c#/paths/~1health~1ready/get/responses/${code}/content/application~1json/schema`;
  validate503 = ajv.compile({ $ref: ptr('503') });
  validate200 = ajv.compile({ $ref: ptr('200') });
});

const fail = async () => {
  throw new Error('down');
};
const hang = () => new Promise(() => undefined);

describe('GET /api/v1/health/ready', () => {
  it('200 when every probe succeeds', async () => {
    const { c } = await fakeContainer();
    const res = await request(createApp(c)).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(validate200(res.body)).toBe(true);
  });

  for (const name of ['db', 'redis', 'rabbitmq', 's3'] as const) {
    for (const [how, fn] of [
      ['fails', fail],
      ['hangs past HEALTH_TIMEOUT_MS', hang],
    ] as const) {
      it(`503 {status: fail} when ${name} ${how}; the others stay ok`, async () => {
        const probes: Probes = { [name]: fn };
        const { c, lines } = await fakeContainer(probes);
        const started = Date.now();
        const res = await request(createApp(c)).get('/api/v1/health/ready');
        expect(Date.now() - started).toBeLessThan(2000);
        expect(res.status).toBe(503);
        expect(res.headers['x-backend']).toBe('express');
        expect(validate503(res.body)).toBe(true);
        expect(res.body).toEqual({
          status: 'fail',
          checks: { db: 'ok', redis: 'ok', rabbitmq: 'ok', s3: 'ok', [name]: 'fail' },
        });
        expect(lines.some((l) => l.msg === 'readiness check failed' && l.check === name)).toBe(true);
      });
    }
  }
});
