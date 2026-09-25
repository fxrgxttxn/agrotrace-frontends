/**
 * scheduler process: periodic jobs, each tick guarded by pg_try_advisory_lock(hashtext('agrotrace.scheduler.<job>'))
 * (spec 8.2). Task 1 starts the process and its shutdown; the jobs arrive with their tasks.
 */
import { createContainer } from './container.js';
import { configOrExit, crashOnUnhandled, onShutdown } from './lifecycle.js';
import { createLogger } from './logger.js';

const config = configOrExit();
const logger = createLogger({ level: config.LOG_LEVEL, process: 'scheduler' });
crashOnUnhandled(logger);
const container = createContainer(config, logger, { process: 'scheduler' });
logger.info('scheduler started (no jobs registered yet)');

const idle = setInterval(() => undefined, 1 << 30);

onShutdown(logger, config.SHUTDOWN_TIMEOUT_MS, async () => {
  clearInterval(idle);
  await container.close();
});
