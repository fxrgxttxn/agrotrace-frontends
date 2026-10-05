import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { bundle, loadConfig } from '@redocly/openapi-core';

const REQUIRED: [string, string][] = [
  ['post', '/auth/login'],
  ['post', '/auth/refresh'],
  ['post', '/auth/logout'],
  ['post', '/auth/register-organization'],
  ['post', '/auth/2fa/verify'],
  ['post', '/auth/2fa/setup'],
  ['post', '/auth/password/forgot'],
  ['post', '/auth/password/reset'],
  ['post', '/auth/accept-invite'],
  ['get', '/me'],
  ['patch', '/me'],
  ['put', '/me/avatar'],
  ['delete', '/me/avatar'],
  ['get', '/me/channels'],
  ['put', '/me/channels'],
  ['post', '/me/telegram-code'],
  ['get', '/users'],
  ['post', '/users'],
  ['patch', '/users/{id}'],
  ['get', '/users/{id}/avatar'],
  ['get', '/organizations'],
  ['get', '/organizations/{id}'],
  ['put', '/organizations/{id}/logo'],
  ['get', '/organizations/{id}/logo'],
  ['get', '/fields'],
  ['post', '/fields'],
  ['get', '/fields/{id}'],
  ['put', '/fields/{id}'],
  ['delete', '/fields/{id}'],
  ['get', '/fields/{id}/treatments'],
  ['post', '/fields/{id}/treatments'],
  ['put', '/treatments/{id}'],
  ['get', '/batches'],
  ['post', '/batches'],
  ['get', '/batches/{id}'],
  ['get', '/batches/{id}/graph'],
  ['get', '/batches/{id}/history'],
  ['get', '/batches/{id}/path'],
  ['post', '/batches/{id}/qr'],
  ['get', '/batches/{id}/qr'],
  ['get', '/batches/{id}/documents'],
  ['post', '/batches/{id}/documents/vsd/retry'],
  ['post', '/batches/{id}/on-sale'],
  ['post', '/batches/{id}/sold'],
  ['post', '/processing'],
  ['get', '/waybills'],
  ['post', '/waybills'],
  ['get', '/waybills/{id}'],
  ['delete', '/waybills/{id}'],
  ['post', '/waybills/{id}/send'],
  ['post', '/waybills/{id}/accept'],
  ['post', '/waybills/{id}/reject'],
  ['get', '/lab-tests'],
  ['post', '/lab-tests'],
  ['get', '/lab-tests/{id}'],
  ['post', '/lab-tests/{id}/sample'],
  ['post', '/lab-tests/{id}/results'],
  ['put', '/lab-tests/{id}/protocol'],
  ['get', '/lab-tests/{id}/protocol'],
  ['get', '/recalls'],
  ['post', '/recalls'],
  ['get', '/recalls/{id}'],
  ['get', '/recalls/{id}/graph'],
  ['get', '/recall-tasks'],
  ['post', '/recall-tasks/{id}/confirm'],
  ['get', '/complaints'],
  ['get', '/complaints/{id}'],
  ['post', '/complaints/{id}/review'],
  ['post', '/complaints/{id}/decision'],
  ['get', '/notifications'],
  ['post', '/notifications/read'],
  ['get', '/events/stream'],
  ['get', '/analytics/dashboard'],
  ['get', '/reports/{type}'],
  ['get', '/admin/organizations'],
  ['patch', '/admin/organizations/{id}'],
  ['post', '/admin/organizations/{id}/approve'],
  ['get', '/dictionaries/{name}'],
  ['post', '/dictionaries/{name}'],
  ['put', '/dictionaries/{name}/{id}'],
  ['delete', '/dictionaries/{name}/{id}'],
  ['post', '/dictionaries/{name}/import'],
  ['put', '/dictionaries/products/{id}/image'],
  ['get', '/audit-log'],
  ['get', '/files/{id}'],
  ['get', '/public/batches/{publicCode}'],
  ['post', '/public/batches/{publicCode}/complaints'],
  ['get', '/public/captcha'],
  ['get', '/public/files/{id}'],
  ['get', '/public/regions'],
  ['get', '/health/live'],
  ['get', '/health/ready'],
];

type Op = { operationId: string; responses: Record<string, unknown>; security?: unknown[] };
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

let paths: Record<string, Record<string, Op>>;

beforeAll(async () => {
  const config = await loadConfig({ configPath: fileURLToPath(new URL('../redocly.yaml', import.meta.url)) });
  const { bundle: b } = await bundle({
    ref: fileURLToPath(new URL('../openapi.yaml', import.meta.url)),
    config,
  });
  paths = (b.parsed as { paths: Record<string, Record<string, Op>> }).paths;
});

const operations = () =>
  Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([m]) => METHODS.includes(m))
      .map(([m, o]) => ({ m, path, o })),
  );

describe('openapi contract: completeness', () => {
  it.each(REQUIRED)('%s %s exists', (m, p) => expect(paths[p]?.[m], `${m} ${p}`).toBeDefined());

  it('declares no operation outside the REQUIRED list', () => {
    const required = new Set(REQUIRED.map(([m, p]) => `${m} ${p}`));
    expect(
      operations()
        .map(({ m, path }) => `${m} ${path}`)
        .filter((k) => !required.has(k)),
    ).toEqual([]);
  });

  it('operationIds are unique', () => {
    const ids = operations().map(({ o }) => o.operationId);
    expect(ids.length).toBe(REQUIRED.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('mutating secured operations declare 401 and 403', () => {
    const bad = operations()
      .filter(({ m, path }) => ['post', 'put', 'patch', 'delete'].includes(m))
      .filter(({ path }) => !path.startsWith('/public') && !path.startsWith('/auth'))
      .filter(({ o }) => !['401', '403'].every((c) => Object.keys(o.responses).includes(c)))
      .map(({ m, path }) => `${m} ${path}`);
    expect(bad).toEqual([]);
  });
});
