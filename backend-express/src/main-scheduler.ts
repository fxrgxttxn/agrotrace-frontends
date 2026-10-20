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
const jobs = [labEscalationJob(container.db)];
// A tick holds one pool client for its advisory lock while the job runs on another: every job may tick at once.
if (config.DB_POOL_MAX < jobs.length + 1) {
  logger.fatal(
    { DB_POOL_MAX: config.DB_POOL_MAX, jobs: jobs.length },
    'scheduler needs DB_POOL_MAX >= jobs + 1',
  );
  process.exit(1);
}
const scheduler = startScheduler({
  pool: container.pool,
  logger,
  jobs,
  intervalMs: config.SCHEDULER_TICK_MS,
});
logger.info({ tickMs: config.SCHEDULER_TICK_MS }, 'scheduler started');

onShutdown(logger, config.SHUTDOWN_TIMEOUT_MS, async () => {
  await scheduler.stop();
  await container.close();
});
