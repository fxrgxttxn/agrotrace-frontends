/**
 * SVG logo sanitization (spec 8.6, Review Focus #5, P15). Nothing heavy ever runs on the API's event loop:
 *
 * 1. UTF-8 (fatal decoding).
 * 2. A streaming pre-scan (`scanSvg`) before any DOM: no DOCTYPE or other `<!…>` declarations (hence no entities),
 *    at most 64 levels of element nesting and at most 5 000 elements; comments, processing instructions and CDATA
 *    must be terminated.
 * 3. The DOM work (svg-sanitize.ts: well-formedness, SVG root, DOMPurify, reference and style filtering) runs in a
 *    worker thread with a 2 s budget per document; past it the worker is terminated (and replaced) and the upload is
 *    refused.
 *
 * Any failure → null; the caller answers 415 UNSUPPORTED_MEDIA_TYPE.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export const SVG_MAX_DEPTH = 64;
export const SVG_MAX_ELEMENTS = 5000;
export const SVG_SANITIZE_TIMEOUT_MS = 2000;

/** Pre-scan result: null — acceptable for the DOM stage; otherwise why not. */
export function scanSvg(text: string): string | null {
  const n = text.length;
  let i = 0;
  let depth = 0;
  let elements = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt < 0) return elements > 0 ? null : 'no element';
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return 'unterminated comment';
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) return 'unterminated CDATA';
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) return 'unterminated processing instruction';
      i = end + 2;
      continue;
    }
    if (text[lt + 1] === '!') return 'declaration (DOCTYPE/ENTITY)';
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      if (end < 0) return 'unterminated end tag';
      depth -= 1;
      if (depth < 0) return 'unbalanced end tag';
      i = end + 1;
      continue;
    }
    let j = lt + 1;
    let quote: string | null = null;
    for (; j < n; j++) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= n) return 'unterminated start tag';
    elements += 1;
    if (elements > SVG_MAX_ELEMENTS) return 'too many elements';
    if (text[j - 1] !== '/') {
      depth += 1;
      if (depth > SVG_MAX_DEPTH) return 'nested too deeply';
    }
    i = j + 1;
  }
}

// ── the sanitizer worker ────────────────────────────────────────────────────────────────────────────────────────

interface Job {
  id: number;
  text: string;
  resolve: (r: string | null) => void;
}

/** A worker that has not reported ready within this long is given up (it never counts against a job's budget). */
const WORKER_START_TIMEOUT_MS = 30_000;

/** dist/svg-worker.js next to the bundle; from sources (tsx, vitest) the .ts entry through tsx. */
function workerSource(): { url: URL; execArgv: string[] } {
  const js = new URL('./svg-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(js))) return { url: js, execArgv: [] };
  return { url: new URL('./svg-worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] };
}

/**
 * One long-lived worker, jobs one at a time. A job's 2 s budget starts when it is handed to a ready worker; on
 * timeout or crash the worker is terminated, the job refused, and a fresh worker serves the rest of the queue.
 */
class SanitizerWorker {
  private worker: Worker | null = null;
  private ready = false;
  private startTimer: NodeJS.Timeout | null = null;
  private readonly queue: Job[] = [];
  private current: { job: Job; timer: NodeJS.Timeout } | null = null;
  private seq = 0;

  run(text: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.queue.push({ id: ++this.seq, text, resolve });
      this.next();
    });
  }

  private spawn(): void {
    const { url, execArgv } = workerSource();
    const w = new Worker(url, { execArgv, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    w.unref(); // never keeps the process alive (shutdown)
    this.worker = w;
    this.ready = false;
    this.startTimer = setTimeout(() => this.startFailed(w), WORKER_START_TIMEOUT_MS);
    w.on('message', (msg: { ready?: boolean; id?: number; result?: string | null }) => {
      if (this.worker !== w) return;
      if (msg.ready) {
        clearTimeout(this.startTimer!);
        this.ready = true;
        this.next();
        return;
      }
      if (this.current?.job.id === msg.id) this.finish(msg.result ?? null);
    });
    // Only the active worker may affect jobs: a terminated predecessor's events are ignored.
    w.on('error', () => {
      if (this.worker === w) this.discard(w);
    });
    w.on('exit', () => {
      if (this.worker === w) this.discard(w);
    });
  }

  private next(): void {
    if (this.current || this.queue.length === 0) return;
    if (!this.worker) this.spawn();
    if (!this.ready) return;
    const job = this.queue.shift()!;
    const timer = setTimeout(() => this.discard(this.worker!), SVG_SANITIZE_TIMEOUT_MS);
    this.current = { job, timer };
    this.worker!.postMessage({ id: job.id, text: job.text });
  }

  private finish(result: string | null): void {
    const cur = this.current;
    if (!cur) return;
    clearTimeout(cur.timer);
    this.current = null;
    cur.job.resolve(result);
    this.next();
  }

  /** Timeout or crash: the worker is terminated, the running job refused; a fresh worker takes the queue. */
  private discard(w: Worker): void {
    if (this.worker !== w) return;
    this.worker = null;
    this.ready = false;
    if (this.startTimer) clearTimeout(this.startTimer);
    void w.terminate();
    if (this.current) this.finish(null);
    else this.next();
  }

  /** The worker never became ready: every waiting job is refused (a later upload starts a new worker). */
  private startFailed(w: Worker): void {
    if (this.worker !== w || this.ready) return;
    this.worker = null;
    void w.terminate();
    for (const job of this.queue.splice(0)) job.resolve(null);
  }
}

let sanitizer: SanitizerWorker | null = null;

export async function sanitizeSvg(bytes: Buffer): Promise<Buffer | null> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (scanSvg(text) !== null) return null;
  sanitizer ??= new SanitizerWorker();
  const out = await sanitizer.run(text);
  return out === null ? null : Buffer.from(out, 'utf8');
}
