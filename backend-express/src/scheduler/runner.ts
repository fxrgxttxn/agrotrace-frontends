/**
 * Periodic jobs of the scheduler process (spec 8.2): every `intervalMs` (and once at start) each job runs only while
 * this process holds the session advisory lock `pg_try_advisory_lock(hashtext('agrotrace.scheduler.<name>'))` — a
 * second scheduler (of any backend sharing the DB) skips the tick. A tick that is still running is not overlapped; a
 * failing tick is logged and the next one runs as usual.
 */
import type pg from 'pg';
import type { Logger } from '../logger.js';

export interface Job {
  /** `agrotrace.scheduler.<name>` is the advisory lock key. */
  name: string;
  /** One tick; returns how many rows it handled (logged). */
  run(): Promise<number>;
}

export interface Scheduler {
  /** One guarded tick of `name` (tests, start-up); false when the lock was held elsewhere or a tick is running. */
  tick(name: string): Promise<boolean>;
  stop(): Promise<void>;
}

export function startScheduler(opts: {
  pool: pg.Pool;
  logger: Logger;
  jobs: readonly Job[];
  intervalMs: number;
}): Scheduler {
  const running = new Map<string, Promise<boolean>>();
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;

  async function guarded(job: Job): Promise<boolean> {
    const client = await opts.pool.connect();
    const key = `agrotrace.scheduler.${job.name}`;
    try {
      const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [
        key,
      ]);
      if (!got.rows[0]?.ok) return false;
      try {
        const n = await job.run();
        if (n > 0) opts.logger.info({ job: job.name, rows: n }, 'scheduler job tick');
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      }
      return true;
    } finally {
      client.release();
    }
  }

  function tick(name: string): Promise<boolean> {
    const job = opts.jobs.find((j) => j.name === name);
    if (!job || stopped) return Promise.resolve(false);
    const busy = running.get(name);
    if (busy) return Promise.resolve(false);
    const p = guarded(job)
      .catch((err: unknown) => {
        opts.logger.error({ job: name, err: (err as Error).message }, 'scheduler job failed');
        return false;
      })
      .finally(() => running.delete(name));
    running.set(name, p);
    return p;
  }

  for (const job of opts.jobs) {
    void tick(job.name);
    timers.push(setInterval(() => void tick(job.name), opts.intervalMs));
  }

  return {
    tick,
    async stop() {
      stopped = true;
      for (const t of timers) clearInterval(t);
      await Promise.allSettled([...running.values()]);
    },
  };
}
