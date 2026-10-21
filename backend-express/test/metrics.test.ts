/**
 * Task 14: Prometheus metrics (infra/metrics.ts, contract info.description «Мониторинг») and the request id in the
 * worker's log lines (infra/consumer.ts). tests/api checks the live endpoint; these pin what HTTP cannot force —
 * a 5xx counted as an error, the gauges read at scrape time, the route label for every contract template.
 */
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { runWithContext } from '../src/context.js';
import type { Db } from '../src/db/db.js';
import { JOBS_QUEUE, type Amqp } from '../src/infra/amqp.js';
import { startConsumer } from '../src/infra/consumer.js';
import { createMetrics, routeMatcher } from '../src/infra/metrics.js';
import type { EventEnvelope } from '../src/infra/outbox.js';
import { createLogger } from '../src/logger.js';
import { memoryLogger, testContract } from './helpers.js';

/** Kysely's sql`…`.execute(db) needs only getExecutor(); every query answers `rows`. */
const fakeDb = (rows: Record<string, unknown>[]) =>
  ({
    getExecutor: () => ({
      transformQuery: (n: unknown) => n,
      compileQuery: (n: unknown) => ({ sql: '', parameters: [], query: n }),
      executeQuery: async () => ({ rows }),
    }),
  }) as unknown as Db;

const fakeAmqp = (messageCount: number) =>
  ({
    connection: {
      createChannel: async () => ({
        on: () => undefined,
        checkQueue: async (q: string) => ({ queue: q, messageCount, consumerCount: 1 }),
        close: async () => undefined,
      }),
    },
  }) as unknown as Amqp;

/** `name{labels} value` lines of the exposition text, labels as a map. */
function series(text: string, name: string): { labels: Record<string, string>; value: number }[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `))
    .map((l) => {
      const m = /^[^{ ]+(?:\{(.*)\})? (\S+)$/.exec(l)!;
      const labels = Object.fromEntries(
        [...(m[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]),
      );
      return { labels, value: Number(m[2]) };
    });
}

describe('routeMatcher: the route label is a contract template', () => {
  it('maps request paths to templates, literal segments before parameters; anything else → unmatched', async () => {
    const route = routeMatcher(Object.keys((await testContract()).doc.paths));
    expect(route('/api/v1/batches/0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e')).toBe('/batches/{id}');
    expect(route('/api/v1/batches/x/qr?format=png')).toBe('/batches/{id}/qr');
    expect(route('/api/v1/dictionaries/products/abc/image')).toBe('/dictionaries/products/{id}/image');
    expect(route('/api/v1/dictionaries/products/abc')).toBe('/dictionaries/{name}/{id}');
    expect(route('/api/v1/health/live')).toBe('/health/live');
    for (const p of [
      '/api/v1/no/such',
      '/api/v1/batches//graph',
      '/metrics',
      '/api/v1',
      '/api/v2/health/live',
    ])
      expect(route(p), p).toBe('unmatched');
  });
});

describe('createMetrics', () => {
  async function scrape(opts: { openRecalls?: string; queue?: number } = {}) {
    const { logger } = memoryLogger();
    const metrics = createMetrics({
      db: fakeDb([{ n: opts.openRecalls ?? '0' }]),
      amqp: fakeAmqp(opts.queue ?? 0),
      logger,
      routes: Object.keys((await testContract()).doc.paths),
    });
    const app = express();
    app.use(metrics.http);
    app.get('/api/v1/health/live', (_req, res) => void res.json({ status: 'ok' }));
    app.get('/api/v1/batches/:id', (_req, res) => void res.status(500).end());
    app.use((_req, res) => void res.status(404).end());
    await request(app).get('/api/v1/health/live');
    await request(app).get('/api/v1/health/live');
    await request(app).get('/api/v1/batches/5a3e');
    await request(app).get('/api/v1/nope');
    return { metrics, text: await metrics.registry.metrics() };
  }

  it('http duration by method, contract route and status; 5xx counted as errors; backend="express" everywhere', async () => {
    const { text } = await scrape();
    const count = series(text, 'http_request_duration_seconds_count');
    expect(count).toContainEqual({
      labels: { method: 'GET', route: '/health/live', status: '200', backend: 'express' },
      value: 2,
    });
    expect(count).toContainEqual({
      labels: { method: 'GET', route: '/batches/{id}', status: '500', backend: 'express' },
      value: 1,
    });
    expect(count).toContainEqual({
      labels: { method: 'GET', route: 'unmatched', status: '404', backend: 'express' },
      value: 1,
    });
    expect(series(text, 'http_request_errors_total')).toEqual([
      { labels: { method: 'GET', route: '/batches/{id}', status: '500', backend: 'express' }, value: 1 },
    ]);
    for (const line of text.split('\n').filter((l) => l && !l.startsWith('#')))
      expect(line, 'every series carries the backend label').toContain('backend="express"');
  });

  it('queue length and open recalls are read at scrape time', async () => {
    const { text } = await scrape({ openRecalls: '7', queue: 3 });
    expect(series(text, 'queue_messages')).toEqual([
      { labels: { queue: JOBS_QUEUE, backend: 'express' }, value: 3 },
    ]);
    expect(series(text, 'recalls_open')).toEqual([{ labels: { backend: 'express' }, value: 7 }]);
  });

  it('a failed or impossible read gives NaN, never the last good value (review M7a)', async () => {
    const { logger } = memoryLogger();
    const failingDb = {
      getExecutor: () => ({
        transformQuery: (n: unknown) => n,
        compileQuery: (n: unknown) => ({ sql: '', parameters: [], query: n }),
        executeQuery: async () => {
          throw new Error('db down');
        },
      }),
    } as unknown as Db;
    const metrics = createMetrics({
      db: failingDb,
      amqp: { connection: null } as unknown as Amqp,
      logger,
      routes: [],
    });
    const text = await metrics.registry.metrics();
    expect(series(text, 'queue_messages')[0]?.value).toBeNaN();
    expect(series(text, 'recalls_open')[0]?.value).toBeNaN();
  });

  it('an aborted request is observed once with status 499; an unknown method is "other" (review M7d, M7e)', async () => {
    const { logger } = memoryLogger();
    const metrics = createMetrics({
      db: fakeDb([{ n: '0' }]),
      amqp: fakeAmqp(0),
      logger,
      routes: ['/health/live'],
    });
    const app = express();
    app.use(metrics.http);
    let aborted!: () => void;
    const closed = new Promise<void>((r) => (aborted = r));
    app.get('/api/v1/health/live', (_req, res) => void res.on('close', () => setTimeout(aborted, 10)));
    app.use((_req, res) => void res.status(404).end());
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const ctl = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/api/v1/health/live`, { signal: ctl.signal }).catch(
        () => undefined,
      );
      await new Promise((r) => setTimeout(r, 50));
      ctl.abort();
      await pending;
      await closed;
      await request(app).search('/api/v1/health/live');
    } finally {
      server.close();
    }
    const count = series(await metrics.registry.metrics(), 'http_request_duration_seconds_count');
    expect(count).toContainEqual({
      labels: { method: 'GET', route: '/health/live', status: '499', backend: 'express' },
      value: 1,
    });
    expect(count.some((s) => s.labels.method === 'other')).toBe(true);
  });

  it('serves GET /metrics on its own listener; any other path or method → 404', async () => {
    const { metrics } = await scrape();
    const server = await metrics.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ok = await fetch(`${base}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
      expect(await ok.text()).toContain('# TYPE http_request_duration_seconds histogram');
      expect((await fetch(`${base}/`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('request id in the logs', () => {
  it('a worker log line carries the handled event requestId; audit/outbox context stays system (null)', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger(
      { level: 'info', process: 'worker' },
      { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
    );
    runWithContext({ requestId: null, ip: null, eventRequestId: 'req-42' }, () => logger.info('handling'));
    expect(lines[0]).toMatchObject({ requestId: 'req-42', backend: 'express', process: 'worker' });
  });

  it('the consumer runs each handler in the context of its event (requestId of the envelope)', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger(
      { level: 'info', process: 'worker' },
      { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
    );
    let deliver: ((msg: unknown) => void) | null = null;
    const acked: unknown[] = [];
    const channel = {
      on: () => undefined,
      prefetch: async () => undefined,
      consume: async (_q: string, cb: (msg: unknown) => void) => {
        deliver ??= cb;
        return { consumerTag: 'c1' };
      },
      ack: (m: unknown) => void acked.push(m),
      reject: () => undefined,
      nack: () => undefined,
      close: async () => undefined,
      checkQueue: async () => ({}),
      cancel: async () => undefined,
    };
    const conn = { createChannel: async () => channel, createConfirmChannel: async () => channel };
    const amqp = { connection: conn, onConnect: (fn: (c: unknown) => void) => fn(conn) };
    const handled = new Promise<void>((resolve) => {
      startConsumer({
        amqp: amqp as unknown as Amqp,
        logger,
        handlers: {
          'rating.recalculate': async (e: EventEnvelope) => {
            logger.info({ eventId: e.id }, 'handled');
            resolve();
          },
        },
      });
    });
    await new Promise((r) => setTimeout(r, 10));
    const envelope = {
      id: 'e1',
      type: 'rating.recalculate',
      occurredAt: new Date().toISOString(),
      backend: 'express',
      requestId: 'req-from-api',
      data: {},
    };
    deliver!({ content: Buffer.from(JSON.stringify(envelope)) });
    await handled;
    expect(lines.find((l) => l.msg === 'handled')).toMatchObject({
      requestId: 'req-from-api',
      eventId: 'e1',
    });
  });
});
