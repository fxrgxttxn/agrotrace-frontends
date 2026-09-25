/**
 * SVG logo sanitization (spec 8.6, Review Focus #5, P15, P18). Nothing heavy ever runs on the API's event loop and
 * no client can hold the sanitizer for long:
 *
 * 1. UTF-8 (fatal decoding).
 * 2. A streaming pre-scan (`scanSvg`) before any DOM, linear in the input:
 *    - no DOCTYPE or other `<!…>` declarations (hence no entities); comments, processing instructions and CDATA
 *      terminated; tags balanced;
 *    - element names from the allowlist `SVG_ELEMENTS` only (case-sensitive, no prefixes) — anything else is refused,
 *      not sanitized;
 *    - complexity limits: nesting ≤ 64, ≤ 5 000 elements, ≤ 100 attributes per element, ≤ 20 000 attributes in all,
 *      ≤ 32 namespace declarations (`xmlns`, `xmlns:*`), every attribute value ≤ 64 KiB.
 * 3. The DOM work (svg-sanitize.ts) runs in worker threads behind bounded queues — two lanes, documents up to 64 KiB
 *    and larger ones, each with its own worker: one job running and at most 8 waiting per lane; every job has a 3 s deadline counted from the moment it is queued (waiting included); a
 *    job whose request went away is dropped (a running one terminates the worker); a full queue or a missed deadline
 *    refuses the upload as too complex. A terminated or crashed worker is replaced with an exponential back-off
 *    (100 ms … 2 s).
 *
 * The caller answers 415 UNSUPPORTED_MEDIA_TYPE; `too-complex` outcomes carry `params.reason = "svg-too-complex"`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export const SVG_MAX_DEPTH = 64;
export const SVG_MAX_ELEMENTS = 5000;
export const SVG_MAX_ATTRS_PER_ELEMENT = 100;
export const SVG_MAX_ATTRS = 20_000;
export const SVG_MAX_NAMESPACES = 32;
export const SVG_MAX_ATTR_VALUE = 64 * 1024;
export const SVG_QUEUE_WAITING = 8;
export const SVG_DEADLINE_MS = 3000;

/**
 * Elements a logo may contain — structure, shapes, text, paint servers, clipping/masking and filter primitives (what
 * the sanitizer's SVG profiles keep; scripting, styling, animation, fonts, `foreignObject`, `use` and `feImage` are
 * not in it).
 */
// prettier-ignore
export const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'defs', 'desc', 'title', 'metadata', 'symbol', 'switch', 'a',
  'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect',
  'text', 'tspan', 'textPath', 'image',
  'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'stop',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB',
  'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight',
  'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]);

export type ScanResult = { ok: true } | { ok: false; tooComplex: boolean; why: string };

const refuse = (why: string): ScanResult => ({ ok: false, tooComplex: false, why });
const tooComplex = (why: string): ScanResult => ({ ok: false, tooComplex: true, why });
const NAME = /[A-Za-z_][\w.:-]*/y;
const SPACE = /[ \t\r\n]/;

/** The pre-scan (P15, P18). */
export function scanSvg(text: string): ScanResult {
  const n = text.length;
  let i = 0;
  let depth = 0;
  let elements = 0;
  let attrs = 0;
  let namespaces = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      if (elements === 0) return refuse('no element');
      return depth === 0 ? { ok: true } : refuse('unclosed element');
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return refuse('unterminated comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) return refuse('unterminated CDATA');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) return refuse('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (text[lt + 1] === '!') return refuse('declaration (DOCTYPE/ENTITY)');
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      if (end < 0) return refuse('unterminated end tag');
      depth -= 1;
      if (depth < 0) return refuse('unbalanced end tag');
      i = end + 1;
      continue;
    }

    // A start tag: the name, then attributes name="value" / name='value'.
    NAME.lastIndex = lt + 1;
    const name = NAME.exec(text)?.[0];
    if (!name) return refuse('malformed start tag');
    if (!SVG_ELEMENTS.has(name)) return refuse(`element ${name} is not allowed`);
    elements += 1;
    if (elements > SVG_MAX_ELEMENTS) return tooComplex('too many elements');
    let j = lt + 1 + name.length;
    let own = 0;
    let selfClosing = false;
    for (;;) {
      while (j < n && SPACE.test(text[j]!)) j++;
      if (j >= n) return refuse('unterminated start tag');
      if (text[j] === '>') break;
      if (text[j] === '/' && text[j + 1] === '>') {
        selfClosing = true;
        j += 1;
        break;
      }
      NAME.lastIndex = j;
      const attr = NAME.exec(text)?.[0];
      if (!attr) return refuse('malformed attribute');
      j += attr.length;
      while (j < n && SPACE.test(text[j]!)) j++;
      if (text[j] !== '=') return refuse('attribute without a value');
      j += 1;
      while (j < n && SPACE.test(text[j]!)) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") return refuse('unquoted attribute value');
      const end = text.indexOf(quote, j + 1);
      if (end < 0) return refuse('unterminated attribute value');
      if (end - j - 1 > SVG_MAX_ATTR_VALUE) return tooComplex('attribute value too long');
      if (text.slice(j + 1, end).includes('<')) return refuse('`<` in an attribute value');
      j = end + 1;
      own += 1;
      attrs += 1;
      if (attr === 'xmlns' || attr.startsWith('xmlns:')) namespaces += 1;
      if (own > SVG_MAX_ATTRS_PER_ELEMENT) return tooComplex('too many attributes on an element');
      if (attrs > SVG_MAX_ATTRS) return tooComplex('too many attributes');
      if (namespaces > SVG_MAX_NAMESPACES) return tooComplex('too many namespace declarations');
    }
    if (!selfClosing) {
      depth += 1;
      if (depth > SVG_MAX_DEPTH) return tooComplex('nested too deeply');
    }
    i = j + 1;
  }
}

// ── the sanitizer engine and its queue ──────────────────────────────────────────────────────────────────────────

/** Something that sanitizes one document at a time (a worker thread; a stub in unit tests). */
export interface SanitizerEngine {
  /** Resolves once the engine can take jobs; rejects if it never can. */
  ready: Promise<void>;
  /** The sanitized document or null; rejects if the engine died. */
  run(text: string): Promise<string | null>;
  terminate(): void;
}

export type SanitizeOutcome =
  { ok: true; svg: string } | { ok: false; reason: 'invalid' | 'too-complex' | 'aborted' };

/** A worker that has not reported ready within this long is given up. */
const WORKER_START_TIMEOUT_MS = 30_000;

/** dist/svg-worker.js next to the bundle; from sources (tsx) the .ts entry through tsx. */
function workerSource(): { url: URL; execArgv: string[] } {
  const js = new URL('./svg-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(js))) return { url: js, execArgv: [] };
  return { url: new URL('./svg-worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] };
}

export function workerEngine(): SanitizerEngine {
  const { url, execArgv } = workerSource();
  const w = new Worker(url, { execArgv, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  w.unref(); // never keeps the process alive (shutdown)
  let pending: { id: number; resolve: (r: string | null) => void; reject: (e: Error) => void } | null = null;
  let seq = 0;
  let dead = false;
  const died = (err: Error) => {
    dead = true;
    pending?.reject(err);
    pending = null;
  };
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('sanitizer worker did not start')),
      WORKER_START_TIMEOUT_MS,
    );
    timer.unref();
    w.on('message', (msg: { ready?: boolean; id?: number; result?: string | null }) => {
      if (msg.ready) {
        clearTimeout(timer);
        resolve();
      } else if (pending && pending.id === msg.id) {
        const p = pending;
        pending = null;
        p.resolve(msg.result ?? null);
      }
    });
    w.on('error', (err) => {
      reject(err);
      died(err);
    });
    w.on('exit', () => {
      const err = new Error('sanitizer worker exited');
      reject(err);
      died(err);
    });
  });
  ready.catch(() => undefined);
  return {
    ready,
    run(text) {
      if (dead) return Promise.reject(new Error('sanitizer worker is gone'));
      return new Promise((resolve, reject) => {
        pending = { id: ++seq, resolve, reject };
        w.postMessage({ id: seq, text });
      });
    },
    terminate() {
      dead = true;
      void w.terminate();
    },
  };
}

interface Job {
  text: string;
  settle: (o: SanitizeOutcome) => void;
  done: boolean;
  deadline: NodeJS.Timeout;
  onAbort: (() => void) | null;
}

/**
 * The bounded queue (P18). One job runs, at most `maxWaiting` wait; each job has one deadline from enqueue. Dropping
 * the running job (deadline, abort, engine failure) terminates the engine; the next one is created after a back-off
 * that doubles with consecutive failures (100 ms … 2 s) and resets after a completed job.
 */
export class SanitizerQueue {
  private engine: SanitizerEngine | null = null;
  private readonly waiting: Job[] = [];
  private running: Job | null = null;
  private failures = 0;
  private spawnAt = 0;
  private wake: NodeJS.Timeout | null = null;

  constructor(
    private readonly factory: () => SanitizerEngine = workerEngine,
    private readonly opts: { maxWaiting: number; deadlineMs: number } = {
      maxWaiting: SVG_QUEUE_WAITING,
      deadlineMs: SVG_DEADLINE_MS,
    },
  ) {}

  run(text: string, signal?: AbortSignal): Promise<SanitizeOutcome> {
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'aborted' });
    if (this.running && this.waiting.length >= this.opts.maxWaiting)
      return Promise.resolve({ ok: false, reason: 'too-complex' });
    return new Promise((resolve) => {
      const job: Job = {
        text,
        done: false,
        onAbort: null,
        deadline: setTimeout(() => this.drop(job, 'too-complex'), this.opts.deadlineMs),
        settle: (o) => {
          if (job.done) return;
          job.done = true;
          clearTimeout(job.deadline);
          if (job.onAbort) signal?.removeEventListener('abort', job.onAbort);
          resolve(o);
        },
      };
      if (signal) {
        job.onAbort = () => this.drop(job, 'aborted');
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

  private drop(job: Job, reason: 'too-complex' | 'aborted'): void {
    if (job.done) return;
    const idx = this.waiting.indexOf(job);
    if (idx >= 0) this.waiting.splice(idx, 1);
    job.settle({ ok: false, reason });
    if (this.running === job) {
      this.running = null;
      this.discardEngine();
      this.pump();
    }
  }

  private discardEngine(): void {
    this.engine?.terminate();
    this.engine = null;
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
    }
    const engine = this.engine;
    const job = this.waiting.shift()!;
    this.running = job;
    void (async () => {
      let outcome: SanitizeOutcome;
      try {
        await engine.ready;
        if (job.done) return;
        const svg = await engine.run(job.text);
        outcome = svg === null ? { ok: false, reason: 'invalid' } : { ok: true, svg };
        if (this.engine === engine) this.failures = 0;
      } catch {
        // The engine died under this job (or never started): the job is refused, the engine replaced.
        if (job.done) return;
        outcome = { ok: false, reason: 'too-complex' };
        if (this.engine === engine) this.discardEngine();
      }
      if (this.running === job) this.running = null;
      job.settle(outcome);
      this.pump();
    })();
  }
}

/**
 * Two lanes, each its own worker and bounded queue: documents up to 64 KiB (every ordinary logo — cheap by
 * construction) never wait behind large ones, so a flood of large documents cannot starve them (P18).
 */
export const SVG_SMALL_LANE_BYTES = 64 * 1024;
const lanes: { small: SanitizerQueue | null; large: SanitizerQueue | null } = { small: null, large: null };

/** Decode, pre-scan, sanitize (P15, P18). */
export async function sanitizeSvg(bytes: Buffer, signal?: AbortSignal): Promise<SanitizeOutcome> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const scan = scanSvg(text);
  if (!scan.ok) return { ok: false, reason: scan.tooComplex ? 'too-complex' : 'invalid' };
  const lane = bytes.length <= SVG_SMALL_LANE_BYTES ? 'small' : 'large';
  const queue = (lanes[lane] ??= new SanitizerQueue());
  return queue.run(text, signal);
}
