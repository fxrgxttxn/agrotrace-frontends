/**
 * worker process: consumes `agrotrace.express.jobs` (envelope, R55/R56, R92 — infra/consumer.ts). Handlers:
 * `vsd.import` (Task 6, R81), `recall.requested` and `rating.recalculate` (Task 10, BR-09); Task 12 adds
 * `notification.dispatch` and `lab.escalate`. Outbox rows a handler writes (e.g. the `rating.recalculate` of a
 * recall) are published right after its commit through the relay (the API's sweeper retries them).
 */
import { createContainer } from './container.js';
import { configOrExit, crashOnUnhandled, onShutdown } from './lifecycle.js';
import { createLogger } from './logger.js';
import { ratingRecalculateHandler } from './events/consumers/rating-recalculate.js';
import { recallRequestedHandler } from './events/consumers/recall-requested.js';
import { startConsumer } from './infra/consumer.js';
import { createMercury } from './infra/mercury.js';
import { vsdImportHandler } from './modules/documents/vsd-import.js';

const config = configOrExit();
const logger = createLogger({ level: config.LOG_LEVEL, process: 'worker' });
crashOnUnhandled(logger);
const container = createContainer(config, logger, { process: 'worker' });
const mercury = createMercury({
  url: config.MERCURY_URL,
  timeoutMs: config.MERCURY_TIMEOUT_MS,
  failProductCodes: config.MERCURY_FAIL_PRODUCT_CODES,
  failMode: config.MERCURY_FAIL_MODE,
});
const consumer = startConsumer({
  amqp: container.amqp,
  logger,
  handlers: {
    'vsd.import': vsdImportHandler({
      db: container.db,
      mercury,
      logger,
      retryBaseMs: config.MERCURY_RETRY_BASE_MS,
    }),
    'recall.requested': recallRequestedHandler({ db: container.db, relay: container.relay }),
    'rating.recalculate': ratingRecalculateHandler({ db: container.db }),
  },
});
container.amqp.start();
logger.info('worker started');

// Keeps the event loop alive while no consumer holds it open.
const idle = setInterval(() => undefined, 1 << 30);

onShutdown(logger, config.SHUTDOWN_TIMEOUT_MS, async () => {
  clearInterval(idle);
  await consumer.stop();
  await container.close();
});
