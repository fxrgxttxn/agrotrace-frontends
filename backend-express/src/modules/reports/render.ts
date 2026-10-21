/**
 * Report rendering off the API's event loop (P52, the P24 pattern — infra/worker-queue.ts): one worker thread per API
 * process renders one report at a time (heap ≤ 1 GiB: a 50 000-row PDF needs about 700 MB); at most 4 more wait. A full
 * queue, a job past its 120 s deadline (waiting included) or a crashed worker → 503 BACKEND_UNAVAILABLE `{reason:
 * "report-busy"}`; a client that went away gives up its place (a running render finishes, its file is dropped).
 * Residency: one warm worker per API process once the first report was asked for.
 */
import { AppProblem } from '../../http/problem.js';
import type { RenderJob } from '../../infra/report-render.js';
import { workerEngine, WorkerQueue, type Engine } from '../../infra/worker-queue.js';

export const REPORT_WORKER_HEAP_MB = 1024;
export const REPORT_QUEUE_WAITING = 4;
export const REPORT_DEADLINE_MS = 120_000;

export class ReportAborted extends Error {}

function reportEngine(): Engine<RenderJob, ArrayBuffer | null> {
  return workerEngine(
    {
      js: new URL('./report-worker.js', import.meta.url),
      ts: new URL('../../infra/report-worker.ts', import.meta.url),
    },
    REPORT_WORKER_HEAP_MB,
  );
}

let queue: WorkerQueue<RenderJob, ArrayBuffer | null> | null = null;

export async function renderInWorker(job: RenderJob, signal?: AbortSignal): Promise<Buffer> {
  queue ??= new WorkerQueue(reportEngine, {
    maxWaiting: REPORT_QUEUE_WAITING,
    deadlineMs: REPORT_DEADLINE_MS,
  });
  const out = await queue.run(job, signal);
  if (!out.ok) {
    if (out.reason === 'aborted') throw new ReportAborted();
    throw reportBusy();
  }
  if (out.value === null) throw new Error('report rendering failed');
  return Buffer.from(out.value);
}

/**
 * Admission (N3): true when the queue already holds a running job and REPORT_QUEUE_WAITING waiting ones — checked
 * before the snapshot and the sheet build, so refused requests cost no database work. A burst can still pass the check
 * together; the queue itself stays the hard bound.
 */
export function reportQueueFull(): boolean {
  return queue !== null && queue.size >= 1 + REPORT_QUEUE_WAITING;
}

/** The 503 of a full queue (also used before the snapshot). */
export const reportBusy = () =>
  new AppProblem(503, 'BACKEND_UNAVAILABLE', { params: { reason: 'report-busy' } });
