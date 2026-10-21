/**
 * worker process: consumes `agrotrace.express.jobs` (envelope, R55/R56, R92 — infra/consumer.ts). Handlers:
 * `vsd.import` (R81), `recall.requested`, `rating.recalculate` (BR-09), `notification.dispatch` and `lab.escalate`
 * (notifications: rows in the handler's transaction, EMAIL/TELEGRAM sent after the commit — modules/notifications/
 * delivery.ts). Outbox rows a handler writes (e.g. the `rating.recalculate` of a recall) are published right after
 * its commit through the relay (the API's sweeper retries them). With a bot token, the worker holding `tg:poller`
 * also polls Telegram for `/start <code>` (infra/telegram.ts).
 */
import { createContainer } from './container.js';
import { configOrExit, crashOnUnhandled, onShutdown } from './lifecycle.js';
import { createLogger } from './logger.js';
import { labEscalateHandler } from './events/consumers/lab-escalate.js';
import { notificationDispatchHandler } from './events/consumers/notification-dispatch.js';
import { ratingRecalculateHandler } from './events/consumers/rating-recalculate.js';
import { recallRequestedHandler } from './events/consumers/recall-requested.js';
import { startConsumer } from './infra/consumer.js';
import { createMercury } from './infra/mercury.js';
import { createTelegram, startTelegramPoller } from './infra/telegram.js';
import { vsdImportHandler } from './modules/documents/vsd-import.js';
import { createDelivery } from './modules/notifications/delivery.js';

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
const telegram = createTelegram({ token: config.TELEGRAM_BOT_TOKEN, apiUrl: config.TELEGRAM_API_URL });
const delivery = createDelivery({ db: container.db, mailer: container.mailer, telegram, logger });
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
    'recall.requested': recallRequestedHandler({ db: container.db, relay: container.relay, delivery }),
    'rating.recalculate': ratingRecalculateHandler({ db: container.db }),
    'notification.dispatch': notificationDispatchHandler({ db: container.db, delivery }),
    'lab.escalate': labEscalateHandler({ db: container.db, delivery }),
  },
});
const poller = startTelegramPoller({ db: container.db, redis: container.redis, telegram, logger });
container.amqp.start();
logger.info({ telegram: telegram.configured }, 'worker started');

// Keeps the event loop alive while no consumer holds it open.
const idle = setInterval(() => undefined, 1 << 30);

onShutdown(logger, config.SHUTDOWN_TIMEOUT_MS, async () => {
  clearInterval(idle);
  await consumer.stop();
  await poller.stop();
  await delivery.idle();
  await container.close();
});
