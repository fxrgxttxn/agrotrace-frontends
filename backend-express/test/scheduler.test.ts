/** Scheduler runner (spec 8.2): a tick runs only under its advisory lock, never overlaps, survives a failing job. */
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { startScheduler, type Scheduler } from '../src/scheduler/runner.js';
import { memoryLogger } from './helpers.js';

/** A pool whose clients answer pg_try_advisory_lock with `locked` and record the statements. */
function fakePool(locked: () => boolean) {
  const statements: string[] = [];
  const pool = {
    connect: async () => ({
      query: async (text: string, params: unknown[]) => {
        statements.push(`${text} ${JSON.stringify(params)}`);
        return { rows: [{ ok: locked() }] };
      },
      release: () => undefined,
    }),
  } as unknown as pg.Pool;
  return { pool, statements };
}

let running: Scheduler | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

describe('startScheduler', () => {
  it('runs a job once at start under pg_try_advisory_lock(hashtext(agrotrace.scheduler.<name>)), then unlocks', async () => {
    const { pool, statements } = fakePool(() => true);
    let runs = 0;
    running = startScheduler({
      pool,
      logger: memoryLogger().logger,
      intervalMs: 3_600_000,
      jobs: [{ name: 'lab-escalation', run: async () => ++runs }],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(1);
    expect(statements).toEqual([
      'SELECT pg_try_advisory_lock(hashtext($1)) AS ok ["agrotrace.scheduler.lab-escalation"]',
      'SELECT pg_advisory_unlock(hashtext($1)) ["agrotrace.scheduler.lab-escalation"]',
    ]);
  });

  it('skips the tick when another scheduler holds the lock', async () => {
    const { pool } = fakePool(() => false);
    let runs = 0;
    running = startScheduler({
      pool,
      logger: memoryLogger().logger,
      intervalMs: 3_600_000,
      jobs: [{ name: 'lab-escalation', run: async () => ++runs }],
    });
    expect(await running.tick('lab-escalation')).toBe(false);
    expect(runs).toBe(0);
  });

  it('never overlaps a running tick; a failing job is logged and the next tick runs', async () => {
    const { pool } = fakePool(() => true);
    const { logger, lines } = memoryLogger();
    let release!: () => void;
    let runs = 0;
    let fail = true;
    running = startScheduler({
      pool,
      logger,
      intervalMs: 3_600_000,
      jobs: [
        {
          name: 'slow',
          run: async () => {
            runs++;
            if (fail) {
              await new Promise<void>((r) => (release = r));
              throw new Error('boom');
            }
            return 0;
          },
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(await running.tick('slow')).toBe(false); // the start-up tick is still running
    expect(runs).toBe(1);
    fail = false;
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(lines.some((l) => l.msg === 'scheduler job failed' && l.err === 'boom')).toBe(true);
    expect(await running.tick('slow')).toBe(true);
    expect(runs).toBe(2);
  });
});
