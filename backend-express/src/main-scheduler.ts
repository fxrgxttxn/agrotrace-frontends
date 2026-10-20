/**
 * scheduler process: periodic jobs, each tick guarded by pg_try_advisory_lock(hashtext('agrotrace.scheduler.<job>'))
 * (spec 8.2, scheduler/runner.ts), every SCHEDULER_TICK_MS (5 minutes; the test stand — 1 s). Jobs: `lab-escalation`
 * (Task 9); Task 10 adds `recall-task-overdue`.
 */
import { createContainer } from './container.js';
import { configOrExit, crashOnUnhandled, onShutdown } from './lifecycle.js';
import { createLogger } from './logger.js';
import { labEscalationJob } from './scheduler/jobs/lab-escalation.js';
import { startScheduler } from './scheduler/runner.js';

const config = configOrExit();
const logger = createLogger({ level: config.LOG_LEVEL, process: 'scheduler' });
crashOnUnhandled(logger);
const container = createContainer(config, logger, { process: 'scheduler' });
const scheduler = startScheduler({
  pool: container.pool,
  logger,
  jobs: [labEscalationJob(container.db)],
  intervalMs: config.SCHEDULER_TICK_MS,
});
logger.info({ tickMs: config.SCHEDULER_TICK_MS }, 'scheduler started');

onShutdown(logger, config.SHUTDOWN_TIMEOUT_MS, async () => {
  await scheduler.stop();
  await container.close();
});
