/**
 * Prometheus metrics of the api process (spec 14.5; contract info.description «Метрики»): prom-client text format on
 * a listener of its own, `METRICS_PORT` (9464) `/metrics` — never on the API port, so the gateway (which proxies
 * `/api/` of port 8000 only) cannot expose it; Prometheus scrapes it inside the compose network. Every series carries
 * `backend="express"`.
 *
 * - `http_request_duration_seconds` (histogram; method, route = the contract path template or `unmatched`, status);
 * - `http_request_errors_total` (counter; method, route, status) — responses with status ≥ 500;
 * - `queue_messages` (gauge; queue) — messages ready in the backend's jobs queue, read at scrape time;
 * - `recalls_open` (gauge) — recalls in status OPEN (not deleted) in the shared DB, read at scrape time;
 * - the prom-client default process metrics (CPU, memory, event loop lag, GC).
 */
import { createServer, type Server } from 'node:http';
import type { RequestHandler } from 'express';
import { sql } from 'kysely';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Db } from '../db/db.js';
import type { Logger } from '../logger.js';
import { JOBS_QUEUE, type Amqp } from './amqp.js';

export interface Metrics {
  registry: Registry;
  /** Express middleware: observes every finished response. */
  http: RequestHandler;
  /** Starts the `/metrics` listener; resolves once it listens. */
  listen(port: number): Promise<Server>;
}

const API_PREFIX = '/api/v1';
const SCRAPE_TIMEOUT_MS = 2000;

/**
 * Route label: the contract path template a request path matches (`/api/v1/batches/<uuid>` → `/batches/{id}`), the
 * literal template winning over a parameterised one (`/dictionaries/products/{id}/image`); none → `unmatched`. Bounded
 * cardinality whatever clients send.
 */
export function routeMatcher(templates: readonly string[]): (originalUrl: string) => string {
  const routes = templates
    .map((template) => ({ template, segments: template.split('/') }))
    .sort(
      (a, b) =>
        a.segments.filter((s) => s.startsWith('{')).length -
        b.segments.filter((s) => s.startsWith('{')).length,
    );
  return (originalUrl) => {
    const path = originalUrl.split('?')[0]!;
    if (!path.startsWith(`${API_PREFIX}/`)) return 'unmatched';
    const segments = path.slice(API_PREFIX.length).split('/');
    const hit = routes.find(
      (r) =>
        r.segments.length === segments.length &&
        r.segments.every((s, i) => (s.startsWith('{') ? segments[i]!.length > 0 : s === segments[i])),
    );
    return hit?.template ?? 'unmatched';
  };
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('scrape timeout')), SCRAPE_TIMEOUT_MS).unref(),
    ),
  ]);
}

export function createMetrics(deps: {
  db: Db;
  amqp: Amqp;
  logger: Logger;
  /** The contract path templates (`/batches/{id}`), the `route` label values. */
  routes: readonly string[];
}): Metrics {
  const routeOf = routeMatcher(deps.routes);
  const registry = new Registry();
  registry.setDefaultLabels({ backend: 'express' });
  collectDefaultMetrics({ register: registry });

  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP response time of the API by method, contract route and status',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const errors = new Counter({
    name: 'http_request_errors_total',
    help: 'HTTP responses with status >= 500 by method, contract route and status',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  new Gauge({
    name: 'queue_messages',
    help: 'Messages ready in the jobs queue of the backend (RabbitMQ), read at scrape time',
    labelNames: ['queue'] as const,
    registers: [registry],
    async collect() {
      const conn = deps.amqp.connection;
      if (!conn) return;
      let ch: Awaited<ReturnType<typeof conn.createChannel>> | null = null;
      try {
        ch = await conn.createChannel();
        ch.on('error', () => undefined);
        const q = await withTimeout(ch.checkQueue(JOBS_QUEUE));
        this.set({ queue: JOBS_QUEUE }, q.messageCount);
      } catch (err) {
        deps.logger.warn({ err: (err as Error).message }, 'metrics: queue length unavailable');
      } finally {
        await ch?.close().catch(() => undefined);
      }
    },
  });

  new Gauge({
    name: 'recalls_open',
    help: 'Recalls in status OPEN (not deleted), read at scrape time',
    registers: [registry],
    async collect() {
      try {
        const { rows } = await withTimeout(
          sql<{
            n: string;
          }>`SELECT count(*) AS n FROM recalls WHERE status = 'OPEN' AND deleted_at IS NULL`.execute(deps.db),
        );
        this.set(Number(rows[0]?.n ?? 0));
      } catch (err) {
        deps.logger.warn({ err: (err as Error).message }, 'metrics: open recalls unavailable');
      }
    },
  });

  const http: RequestHandler = (req, res, next) => {
    const end = duration.startTimer();
    res.on('finish', () => {
      const labels = { method: req.method, route: routeOf(req.originalUrl), status: String(res.statusCode) };
      end(labels);
      if (res.statusCode >= 500) errors.inc(labels);
    });
    next();
  };

  return {
    registry,
    http,
    listen(port) {
      const server = createServer((req, res) => {
        if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/metrics') {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found\n');
          return;
        }
        registry.metrics().then(
          (text) => res.writeHead(200, { 'content-type': registry.contentType }).end(text),
          (err: unknown) => {
            deps.logger.error({ err }, 'metrics: scrape failed');
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('scrape failed\n');
          },
        );
      });
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve(server));
      });
    },
  };
}
