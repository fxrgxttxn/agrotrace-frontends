/** Fail-fast configuration: every problem listed, empty strings treated as unset, defaults applied. */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { acceptRequestId } from '../src/http/request-id.js';
import { contractMethods } from '../src/contract.js';
import { testConfig, testContract } from './helpers.js';

const env = Object.fromEntries(Object.entries(testConfig).map(([k, v]) => [k, String(v)]));

describe('loadConfig', () => {
  it('parses a complete environment, coercing numbers', () => {
    const c = loadConfig({ ...env, PORT: '8123' });
    expect(c.PORT).toBe(8123);
    expect(c.S3_REGION).toBe('us-east-1');
  });

  it('applies defaults for optional variables', () => {
    const rest = { ...env };
    for (const k of ['PORT', 'LOG_LEVEL', 'HEALTH_TIMEOUT_MS']) delete rest[k];
    const c = loadConfig(rest);
    expect(c.PORT).toBe(8000);
    expect(c.LOG_LEVEL).toBe('info');
    expect(c.HEALTH_TIMEOUT_MS).toBe(2000);
  });

  it('lists every problem at once; an empty value counts as missing', () => {
    let err: unknown;
    try {
      loadConfig({ ...env, APP_DATABASE_URL: 'mysql://x', JWT_SECRET: 'short', REDIS_URL: '' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const problems = (err as ConfigError).problems.join('\n');
    expect(problems).toMatch(/APP_DATABASE_URL: must be a postgres: or postgresql: URL/);
    expect(problems).toMatch(/JWT_SECRET: must be at least 32 characters/);
    expect(problems).toMatch(/REDIS_URL: Required/);
  });
});

describe('acceptRequestId (R79)', () => {
  it('keeps ^[A-Za-z0-9._-]{1,64}$, otherwise generates a UUID v4; the first of repeated headers counts', () => {
    expect(acceptRequestId('a.B_c-1')).toBe('a.B_c-1');
    expect(acceptRequestId(['first', 'second'])).toBe('first');
    for (const bad of [undefined, '', 'x'.repeat(65), 'a b', 'a/b'])
      expect(acceptRequestId(bad)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
  });
});

describe('contractMethods', () => {
  it('matches path templates segment by segment', async () => {
    const m = contractMethods((await testContract()).doc);
    expect(m('/api/v1/health/live')).toEqual(['GET']);
    expect(m('/api/v1/health/live/')).toEqual(['GET']);
    expect(m('/api/v1/batches/abc/documents')).toEqual(['GET']);
    expect(m('/api/v1/batches/abc/def/documents')).toEqual([]);
    expect(m('/api/v1/nope')).toEqual([]);
    expect(m('/health/live')).toEqual([]);
  });
});
