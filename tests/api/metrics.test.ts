/**
 * Monitoring (spec 14.5, contract info.description «Мониторинг»): the api process serves Prometheus metrics on its own
 * port (METRICS_PORT 9464, `GET /metrics`) inside the deployment network only — neither the API port nor the gateway
 * (which proxies `/api/` of port 8000) exposes them. Series carry `backend`; required families: http duration and
 * errors by contract route, the jobs queue length, the number of open recalls.
 *
 * METRICS_URL: API_METRICS_URL, else the API host on port 9464.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { api } from './lib/client.js';
import { expectContract, expectProblem } from './lib/contract.js';
import { closeDb, query } from './lib/db.js';
import { API_BACKEND, API_URL } from './lib/env.js';

const METRICS_URL =
  process.env.API_METRICS_URL ??
  (() => {
    const u = new URL(API_URL);
    return `${u.protocol}//${u.hostname}:9464/metrics`;
  })();

afterAll(closeDb);

async function scrape(): Promise<string> {
  const res = await fetch(METRICS_URL);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
  return res.text();
}

/** `name{labels} value` samples of the exposition text, labels as a map (label order is not fixed). */
function samples(text: string, name: string): { labels: Record<string, string>; value: number }[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `))
    .map((l) => {
      const m = /^[^{ ]+(?:\{(.*)\})? (\S+)$/.exec(l)!;
      const labels = Object.fromEntries(
        [...(m[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1]!, x[2]!]),
      );
      return { labels, value: Number(m[2]) };
    });
}

const healthCount = (text: string) =>
  samples(text, 'http_request_duration_seconds_count').find(
    (s) =>
      s.labels.method === 'GET' &&
      s.labels.route === '/health/live' &&
      s.labels.status === '200' &&
      s.labels.backend === API_BACKEND,
  )?.value ?? 0;

describe('metrics (Prometheus, spec 14.5)', () => {
  it('declares the required families, each of their series with the backend label', async () => {
    const text = await scrape();
    for (const [family, type] of [
      ['http_request_duration_seconds', 'histogram'],
      ['http_request_errors_total', 'counter'],
      ['queue_messages', 'gauge'],
      ['recalls_open', 'gauge'],
    ])
      expect(text, family).toMatch(new RegExp(`^# TYPE ${family} ${type}$`, 'm'));
    // Other series (process, runtime) and their labels are implementation-defined (contract «Мониторинг»).
    const required =
      /^(http_request_duration_seconds|http_request_errors_total|queue_messages|recalls_open)[_{ ]/;
    for (const line of text.split('\n').filter((l) => required.test(l)))
      expect(line).toContain(`backend="${API_BACKEND}"`);
  });

  it('http duration by method, contract route template and status; a path outside the contract is "unmatched"', async () => {
    const before = healthCount(await scrape());
    for (let i = 0; i < 3; i++) await expectContract(await api().get('/health/live'), 'getHealthLive');
    const card = await api().get('/batches/0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e');
    await expectContract(card, 'getBatch');
    await expectProblem(await api().get('/no/such/path/for-metrics'), 404, 'NOT_FOUND');
    const text = await scrape();
    expect(healthCount(text) - before).toBeGreaterThanOrEqual(3);
    const count = samples(text, 'http_request_duration_seconds_count');
    expect(count.some((s) => s.labels.route === '/batches/{id}' && s.labels.status === '401')).toBe(true);
    expect(count.some((s) => s.labels.route === 'unmatched' && s.labels.status === '404')).toBe(true);
    expect(count.some((s) => s.labels.route?.includes('for-metrics'))).toBe(false);
  });

  it('queue length of the jobs queue and the open recalls of the shared DB', async () => {
    const text = await scrape();
    const queue = samples(text, 'queue_messages').find(
      (s) => s.labels.queue === `agrotrace.${API_BACKEND}.jobs`,
    );
    expect(queue, text).toBeDefined();
    expect(Number.isInteger(queue!.value) && queue!.value >= 0).toBe(true);
    // Nothing in this file opens or closes recalls, but the worker may still finish an event of an earlier file: the
    // scrape and the DB count are compared up to three times (review M9).
    const openInDb = async () =>
      Number(
        (
          await query<{ n: string }>(
            `SELECT count(*) AS n FROM recalls WHERE status = 'OPEN' AND deleted_at IS NULL`,
          )
        )[0]!.n,
      );
    let last: unknown = null;
    for (let i = 0; i < 3; i++) {
      const before = await openInDb();
      const scraped = samples(await scrape(), 'recalls_open');
      const after = await openInDb();
      last = { before, scraped, after };
      if (
        before === after &&
        JSON.stringify(scraped) === JSON.stringify([{ labels: { backend: API_BACKEND }, value: before }])
      )
        return;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect.fail(`recalls_open never matched the DB count: ${JSON.stringify(last)}`);
  });

  it('not exposed on the API port: /api/v1/metrics and :8000/metrics → 404 (the gateway proxies /api/ of :8000 only)', async () => {
    await expectProblem(await api().get('/metrics'), 404, 'NOT_FOUND');
    const root = new URL(API_URL);
    const res = await fetch(`${root.protocol}//${root.host}/metrics`);
    expect(res.status).toBe(404);
  });
});
