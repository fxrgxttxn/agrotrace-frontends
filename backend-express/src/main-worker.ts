/**
 * worker process: consumes `agrotrace.express.jobs` (envelope, R55/R56). Task 1 starts the process, its connections
 * and graceful shutdown; the event handlers (and the vsd.import lane, R92) arrive with Task 12.
 */
import { createContainer } from './container.js';
import { configOrExit, crashOnUnhandled, onShutdown } from './lifecycle.js';
import { createLogger } from './logger.js';
import { JOBS_QUEUE } from './infra/amqp.js';

const config = configOrExit();
const logger = createLogger({ level: config.LOG_LEVEL, process: 'worker' });
crashOnUnhandled(logger);
const container = createContainer(config, logger, { process: 'worker' });
container.amqp.onConnect(() =>
  logger.info({ queue: JOBS_QUEUE }, 'worker connected (no handlers registered yet)'),
);
container.amqp.start();
logger.info('worker started');

// Keeps the event loop alive while no consumer holds it open.
const idle = setInterval(() => undefined, 1 << 30);

onShutdown(logger, config.SHUTDOWN_TIMEOUT_MS, async () => {
  clearInterval(idle);
  await container.close();
});
