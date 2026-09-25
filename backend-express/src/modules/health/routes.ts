/**
 * getHealthLive / getHealthReady (contracts/openapi/paths/health.yaml). Ready checks PostgreSQL, Redis, RabbitMQ and
 * MinIO concurrently, each bounded by HEALTH_TIMEOUT_MS; any `fail` → 503 with the same body shape.
 */
import { Router } from 'express';
import { ah } from '../../http/async.js';
import { sql } from 'kysely';
import type { Container } from '../../container.js';

type Status = 'ok' | 'fail';
type CheckName = 'db' | 'redis' | 'rabbitmq' | 's3';

async function probe(fn: (signal: AbortSignal) => Promise<unknown>, timeoutMs: number): Promise<Status> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  try {
    await Promise.race([fn(ac.signal), timeout]);
    return 'ok';
  } catch {
    return 'fail';
  } finally {
    clearTimeout(timer);
  }
}

export function healthRouter(c: Container): Router {
  const r = Router();

  r.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  r.get(
    '/ready',
    ah(async (_req, res) => {
      const t = c.config.HEALTH_TIMEOUT_MS;
      const checks: Record<CheckName, () => Promise<Status>> = {
        db: () => probe(() => sql`SELECT 1`.execute(c.db), t),
        redis: () => probe(() => c.redis.ping(), t),
        rabbitmq: () => probe(() => c.amqp.ping(), t),
        s3: () => probe((signal) => c.s3.ping(signal), t),
      };
      const names = Object.keys(checks) as CheckName[];
      const results = await Promise.all(names.map((n) => checks[n]()));
      const body = {
        status: results.every((s) => s === 'ok') ? 'ok' : 'fail',
        checks: Object.fromEntries(names.map((n, i) => [n, results[i]])),
      };
      for (const n of names.filter((_, i) => results[i] === 'fail'))
        c.logger.warn({ check: n }, 'readiness check failed');
      res.status(body.status === 'ok' ? 200 : 503).json(body);
    }),
  );

  return r;
}
