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
 *    and larger ones, each with its own worker: one job running and at most 8 waiting per lane (also while a worker is
 *    being replaced); every job has a 3 s deadline counted from the moment it is queued (waiting included, the
 *    start-up of the worker the job itself runs on excluded); a full queue or a missed deadline refuses the upload as
 *    too complex. A client that goes away never harms others: its waiting job is removed, its running job finishes
 *    and the result is discarded. Only a missed deadline or a crash terminates a worker; it is replaced with an
 *    exponential back-off (100 ms … 2 s).
 *
 * The caller answers 415 UNSUPPORTED_MEDIA_TYPE; `too-complex` outcomes carry `params.reason = "svg-too-complex"`.
 */
import { workerEngine, WorkerQueue, type Engine } from './worker-queue.js';

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

// ── the sanitizer engine and its queue (infra/worker-queue.ts) ────────────────────────────────────────────────────

/** Something that sanitizes one document at a time (a worker thread; a stub in unit tests): the document or null. */
export type SanitizerEngine = Engine<string, string | null>;

export type SanitizeOutcome =
  { ok: true; svg: string } | { ok: false; reason: 'invalid' | 'too-complex' | 'aborted' };

/** dist/svg-worker.js next to the bundle; from sources (tsx) the .ts entry through tsx. */
export function svgWorkerEngine(): SanitizerEngine {
  return workerEngine(
    { js: new URL('./svg-worker.js', import.meta.url), ts: new URL('./svg-worker.ts', import.meta.url) },
    256,
  );
}

/** The bounded SVG queue (P18): WorkerQueue, with `null` from the sanitizer meaning an invalid document. */
export class SanitizerQueue {
  private readonly queue: WorkerQueue<string, string | null>;

  constructor(
    factory: () => SanitizerEngine = svgWorkerEngine,
    opts: { maxWaiting: number; deadlineMs: number } = {
      maxWaiting: SVG_QUEUE_WAITING,
      deadlineMs: SVG_DEADLINE_MS,
    },
  ) {
    this.queue = new WorkerQueue(factory, opts);
  }

  async run(text: string, signal?: AbortSignal): Promise<SanitizeOutcome> {
    const o = await this.queue.run(text, signal);
    if (!o.ok) return o;
    return o.value === null ? { ok: false, reason: 'invalid' } : { ok: true, svg: o.value };
  }

  /** Jobs currently held (running + waiting). */
  get size(): number {
    return this.queue.size;
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
