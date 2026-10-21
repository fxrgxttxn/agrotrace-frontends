/**
 * Composition root: every long-lived resource of a process (manual DI). The API, the worker and the scheduler build
 * the same container; each closes it on shutdown.
 */
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { Config } from './config.js';
import type { OpenApiDoc } from './contract.js';
import type { Logger } from './logger.js';
import type { Metrics } from './infra/metrics.js';
import { createDb, type Db } from './db/db.js';
import { Amqp } from './infra/amqp.js';
import { createDaData, type DaData } from './infra/dadata.js';
import { createFileUrls, type FileUrls } from './infra/file-urls.js';
import { createMailer, type Mailer } from './infra/mailer.js';
import { createOutboxRelay, type OutboxRelay } from './infra/relay.js';
import { createRedis } from './infra/redis.js';
import { createS3, type S3 } from './infra/s3.js';
import type { SseHub } from './sse/hub.js';

export interface Container {
  config: Config;
  logger: Logger;
  db: Db;
  pool: pg.Pool;
  redis: Redis;
  s3: S3;
  amqp: Amqp;
  mailer: Mailer;
  dadata: DaData;
  fileUrls: FileUrls;
  /** Outbox relay + sweeper (publishing side, R55/R56); started by the API process only. */
  relay: OutboxRelay;
  /** SSE hub (LISTEN notifications, R33); the API process sets it before createApp, others leave null. */
  sse: SseHub | null;
  /** Prometheus metrics (API process only, set by main-api before createApp; infra/metrics.ts). */
  metrics: Metrics | null;
  /** The bundled contract (API process only). */
  contract: { doc: OpenApiDoc; raw: string } | null;
  close(): Promise<void>;
}

export function createContainer(
  config: Config,
  logger: Logger,
  opts: { process: 'api' | 'worker' | 'scheduler'; contract?: { doc: OpenApiDoc; raw: string } },
): Container {
  const { db, pool } = createDb({
    url: config.APP_DATABASE_URL,
    max: config.DB_POOL_MAX,
    applicationName: `agrotrace-express-${opts.process}`,
  });
  pool.on('error', (err) => logger.warn({ err: err.message }, 'idle database client error'));
  const redis = createRedis(config.REDIS_URL, logger);
  const s3 = createS3(config);
  const amqp = new Amqp(config.RABBITMQ_URL, logger, `agrotrace-express-${opts.process}`);
  const mailer = createMailer(
    { host: config.SMTP_HOST, port: config.SMTP_PORT, from: config.SMTP_FROM },
    logger,
  );
  const relay = createOutboxRelay({ db, amqp, logger });
  const dadata = createDaData(
    { apiKey: config.DADATA_API_KEY, url: config.DADATA_URL, timeoutMs: config.DADATA_TIMEOUT_MS },
    logger,
  );
  return {
    config,
    logger,
    db,
    pool,
    redis,
    s3,
    amqp,
    mailer,
    dadata,
    fileUrls: createFileUrls(config.JWT_SECRET),
    relay,
    sse: null,
    metrics: null,
    contract: opts.contract ?? null,
    async close() {
      // quit() waits for pending replies — only on a live connection; a reconnecting client is just dropped.
      const redisDone = redis.status === 'ready' ? redis.quit() : Promise.resolve(redis.disconnect());
      await this.sse?.close();
      await relay.stop();
      await Promise.allSettled([amqp.close(), redisDone, db.destroy()]);
      s3.client.destroy();
      mailer.close();
    },
  };
}
