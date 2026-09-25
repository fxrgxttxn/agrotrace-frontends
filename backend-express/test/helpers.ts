/** Unit-test doubles: a container whose dependencies are stubs, a logger that records lines. */
import { fileURLToPath } from 'node:url';
import { bundle, loadConfig as loadRedocly } from '@redocly/openapi-core';
import { pino } from 'pino';
import type { Config } from '../src/config.js';
import type { Container } from '../src/container.js';
import type { OpenApiDoc } from '../src/contract.js';

const CONTRACTS = fileURLToPath(new URL('../../contracts/', import.meta.url));

let bundled: Promise<{ doc: OpenApiDoc; raw: string }> | null = null;
export function testContract(): Promise<{ doc: OpenApiDoc; raw: string }> {
  bundled ??= (async () => {
    const config = await loadRedocly({ configPath: `${CONTRACTS}redocly.yaml` });
    const doc = (await bundle({ ref: `${CONTRACTS}openapi.yaml`, config })).bundle.parsed as OpenApiDoc;
    return { doc, raw: JSON.stringify(doc) };
  })();
  return bundled;
}

export function memoryLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'debug' },
    { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
  );
  return { logger, lines };
}

export const testConfig = {
  NODE_ENV: 'test',
  PORT: 8000,
  LOG_LEVEL: 'debug',
  APP_DATABASE_URL: 'postgres://u:p@localhost:5432/x',
  DB_POOL_MAX: 1,
  REDIS_URL: 'redis://localhost:6379/0',
  RABBITMQ_URL: 'amqp://localhost',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'b',
  S3_BUCKET: 'c',
  S3_REGION: 'us-east-1',
  JWT_SECRET: 'x'.repeat(32),
  PUBLIC_BASE_URL: 'http://localhost',
  SMTP_HOST: 'localhost',
  SMTP_PORT: 1025,
  SMTP_FROM: 'AgroTrace <noreply@agrotrace.local>',
  DADATA_URL: 'http://dadata.invalid/party',
  DADATA_TIMEOUT_MS: 3000,
  RATE_LIMIT_OVERRIDES: {},
  HEALTH_TIMEOUT_MS: 200,
  SHUTDOWN_TIMEOUT_MS: 100,
} satisfies Config;

export interface Probes {
  db?: () => Promise<unknown>;
  redis?: () => Promise<unknown>;
  rabbitmq?: () => Promise<unknown>;
  s3?: () => Promise<unknown>;
}

/** A container whose readiness probes are the given functions (default: all ok). */
export async function fakeContainer(probes: Probes = {}) {
  const { logger, lines } = memoryLogger();
  const ok = async () => undefined;
  const c = {
    config: testConfig,
    logger,
    // Kysely's sql`SELECT 1`.execute(db) calls db.getExecutor(); the stub only needs to fail or succeed.
    db: {
      getExecutor: () => ({
        transformQuery: (n: unknown) => n,
        compileQuery: (n: unknown) => ({ sql: 'SELECT 1', parameters: [], query: n }),
        executeQuery: async () => {
          await (probes.db ?? ok)();
          return { rows: [{ '?column?': 1 }] };
        },
      }),
    },
    pool: {},
    redis: { ping: probes.redis ?? ok },
    s3: { ping: probes.s3 ?? ok, client: { destroy() {} }, bucket: 'c' },
    amqp: { ping: probes.rabbitmq ?? ok },
    contract: await testContract(),
    close: async () => undefined,
  } as unknown as Container;
  return { c, lines };
}
