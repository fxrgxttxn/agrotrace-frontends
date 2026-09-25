/**
 * Heavy parsing off the API's event loop (P18 for SVG, P24 for XLSX): a worker-thread engine behind a bounded queue.
 *
 * - At most `maxWaiting` jobs wait — counted whether or not an engine currently exists (a back-off never lifts the
 *   bound) — and one runs; an overflow is refused at once (`too-complex`).
 * - Every job has one deadline counted from enqueue, waiting included; the only time it does not count is the start-up
 *   of the engine the job itself runs on (its clock pauses until that engine is ready — a respawn is charged to
 *   nobody, and never twice).
 * - A missed deadline or a real engine failure (a crash, the heap limit) terminates the engine — the work stops, it is
 *   not left running — and the engine is replaced with a back-off (100 ms doubling to 2 s, reset after a completed
 *   job). A client that goes away (abort) never does: a waiting job is removed; a running job runs to completion on
 *   the same engine and its result is discarded.
 *
 * Worker protocol: the worker posts `{ready: true}` once warm; the parent posts `{id, input}`; the worker answers
 * `{id, result}`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/** Something that runs one job at a time (a worker thread; a stub in unit tests). */
export interface Engine<I, R> {
  /** Resolves once the engine can take jobs; rejects if it never can. */
  ready: Promise<void>;
  /** The job's result; rejects if the engine died (crash, heap limit, termination). */
  run(input: I): Promise<R>;
  terminate(): void;
}

export type QueueOutcome<R> = { ok: true; value: R } | { ok: false; reason: 'too-complex' | 'aborted' };

/** A worker that has not reported ready within this long is given up. */
const WORKER_START_TIMEOUT_MS = 30_000;

/**
 * A worker-thread engine: `dist/<name>.js` next to the bundle, or the `.ts` source through tsx (sources, tests).
 * `resourceLimits` bound the worker's heap — exceeding it kills the worker, never the API process.
 */
export function workerEngine<I, R>(
  source: { js: URL; ts: URL },
  maxOldGenerationSizeMb: number,
): Engine<I, R> {
  const fromDist = existsSync(fileURLToPath(source.js));
  const w = new Worker(fromDist ? source.js : source.ts, {
    execArgv: fromDist ? [] : ['--import', 'tsx'],
    resourceLimits: { maxOldGenerationSizeMb },
  });
  w.unref(); // never keeps the process alive (shutdown)
  let pending: { id: number; resolve: (r: R) => void; reject: (e: Error) => void } | null = null;
  let seq = 0;
  let dead = false;
  const died = (err: Error) => {
    dead = true;
    pending?.reject(err);
    pending = null;
  };
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not start')), WORKER_START_TIMEOUT_MS);
    timer.unref();
    w.on('message', (msg: { ready?: boolean; id?: number; result?: R }) => {
      if (msg.ready) {
        clearTimeout(timer);
        resolve();
      } else if (pending && pending.id === msg.id) {
        const p = pending;
        pending = null;
        p.resolve(msg.result as R);
      }
    });
    w.on('error', (err) => {
      reject(err);
      died(err);
    });
    w.on('exit', () => {
      const err = new Error('worker exited');
      reject(err);
      died(err);
    });
  });
  ready.catch(() => undefined);
  return {
    ready,
    run(input) {
      if (dead) return Promise.reject(new Error('worker is gone'));
      return new Promise((resolve, reject) => {
        pending = { id: ++seq, resolve, reject };
        w.postMessage({ id: seq, input });
      });
    },
    terminate() {
      dead = true;
      void w.terminate();
    },
  };
}

interface Job<I, R> {
  input: I;
  /** The caller has its answer (result, refusal or abort). */
  settled: boolean;
  resolve: (o: QueueOutcome<R>) => void;
  /** Deadline bookkeeping: the timer runs while the job waits or runs on a ready engine. */
  deadline: NodeJS.Timeout | null;
  deadlineAt: number;
  remaining: number;
  onAbort: (() => void) | null;
  signal?: AbortSignal;
}

export class WorkerQueue<I, R> {
  private engine: Engine<I, R> | null = null;
  private engineReady = false;
  private readonly waiting: Job<I, R>[] = [];
  private running: Job<I, R> | null = null;
  private failures = 0;
  private spawnAt = 0;
  private wake: NodeJS.Timeout | null = null;

  constructor(
    private readonly factory: () => Engine<I, R>,
    private readonly opts: { maxWaiting: number; deadlineMs: number },
  ) {}

  run(input: I, signal?: AbortSignal): Promise<QueueOutcome<R>> {
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'aborted' });
    if (this.waiting.length >= this.opts.maxWaiting)
      return Promise.resolve({ ok: false, reason: 'too-complex' });
    return new Promise((resolve) => {
      const job: Job<I, R> = {
        input,
        settled: false,
        resolve,
        deadline: null,
        deadlineAt: 0,
        remaining: this.opts.deadlineMs,
        onAbort: null,
        signal,
      };
      this.startClock(job);
      if (signal) {
        job.onAbort = () => this.abort(job);
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.waiting.push(job);
      this.pump();
    });
  }

  /** Jobs currently held (running + waiting). */
  get size(): number {
    return (this.running ? 1 : 0) + this.waiting.length;
  }

  private startClock(job: Job<I, R>): void {
    job.deadlineAt = Date.now() + job.remaining;
    job.deadline = setTimeout(() => this.expire(job), job.remaining);
  }

  private pauseClock(job: Job<I, R>): void {
    if (!job.deadline) return;
    clearTimeout(job.deadline);
    job.deadline = null;
    job.remaining = Math.max(0, job.deadlineAt - Date.now());
  }

  private settle(job: Job<I, R>, o: QueueOutcome<R>): void {
    if (job.settled) return;
    job.settled = true;
    if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
    job.resolve(o);
  }

  /** The job's slot is free (it finished, expired or crashed): stop its clock. */
  private release(job: Job<I, R>): void {
    if (job.deadline) clearTimeout(job.deadline);
    job.deadline = null;
    if (this.running === job) this.running = null;
  }

  /** Client gone: a waiting job leaves the queue; a running one keeps its slot until it finishes (result dropped). */
  private abort(job: Job<I, R>): void {
    const idx = this.waiting.indexOf(job);
    if (idx >= 0) {
      this.waiting.splice(idx, 1);
      this.release(job);
    }
    this.settle(job, { ok: false, reason: 'aborted' });
  }

  /** Missed deadline: a waiting job is refused; a running one also takes its engine down. */
  private expire(job: Job<I, R>): void {
    job.deadline = null;
    const idx = this.waiting.indexOf(job);
    if (idx >= 0) this.waiting.splice(idx, 1);
    this.settle(job, { ok: false, reason: 'too-complex' });
    if (this.running === job) {
      this.release(job);
      this.discardEngine();
      this.pump();
    }
  }

  private discardEngine(): void {
    this.engine?.terminate();
    this.engine = null;
    this.engineReady = false;
    this.failures += 1;
    this.spawnAt = Date.now() + Math.min(2000, 100 * 2 ** (this.failures - 1));
  }

  private pump(): void {
    if (this.running || this.waiting.length === 0) return;
    if (!this.engine) {
      const wait = this.spawnAt - Date.now();
      if (wait > 0) {
        this.wake ??= setTimeout(() => {
          this.wake = null;
          this.pump();
        }, wait);
        return;
      }
      this.engine = this.factory();
      this.engineReady = false;
    }
    const engine = this.engine;
    const job = this.waiting.shift()!;
    this.running = job;
    void (async () => {
      let outcome: QueueOutcome<R>;
      try {
        if (!this.engineReady) {
          // The start-up of the engine this job runs on is not charged to the job.
          this.pauseClock(job);
          await engine.ready;
          if (this.engine === engine) this.engineReady = true;
          if (this.running !== job) return; // expired meanwhile (cannot happen while paused, kept for safety)
          this.startClock(job);
        }
        const value = await engine.run(job.input);
        if (this.running !== job) return; // the deadline already took this job (and the engine)
        outcome = { ok: true, value };
        this.failures = 0;
      } catch {
        // A real engine failure (crash, heap limit, never started): the job is refused, the engine replaced.
        if (this.running !== job) return;
        outcome = { ok: false, reason: 'too-complex' };
        if (this.engine === engine) this.discardEngine();
      }
      this.release(job);
      this.settle(job, outcome); // no-op for an aborted job: its result is simply dropped
      this.pump();
    })();
  }
}
