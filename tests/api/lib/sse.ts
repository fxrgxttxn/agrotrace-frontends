/**
 * A minimal Server-Sent Events reader over fetch (GET /events/stream, contracts/openapi/paths/events.yaml): parses
 * `id:` / `event:` / `data:` fields into events; `next(type)` waits for the next event of a type (already received
 * events included, in order). Only HTTP — the same thing a browser EventSource does.
 */
import type { ApiResponse } from './client.js';
import { API_URL } from './env.js';
import { markReal, recordCall } from './registry.js';

export interface SseEvent {
  id?: string;
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- data is checked by the tests against the contract
  data: any;
  raw: string;
}

export interface SseStream {
  status: number;
  headers: Headers;
  /** The response head as an ApiResponse (no body) for expectContract. */
  response: ApiResponse;
  /** Every event received so far, in order. */

  events: SseEvent[];
  /** The next unconsumed event of `type` (waits up to `timeoutMs`). */
  next(type: string, timeoutMs?: number): Promise<SseEvent>;
  /** Resolves when the server ended the stream. */
  ended: Promise<void>;
  close(): void;
}

export async function openStream(opts: {
  token: string;
  lastEventId?: string;
  /** `Last-Event-ID` header. */
  header?: string;
}): Promise<SseStream> {
  const url = new URL(`${API_URL}/events/stream`);
  url.searchParams.set('access_token', opts.token);
  if (opts.lastEventId !== undefined) url.searchParams.set('lastEventId', opts.lastEventId);
  const abort = new AbortController();
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (opts.header !== undefined) headers['last-event-id'] = opts.header;
  const res = await fetch(url, { headers, signal: abort.signal });
  recordCall({ method: 'GET', path: '/events/stream', status: res.status });
  const events: SseEvent[] = [];
  const consumed = new Set<SseEvent>();
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach((w) => w());
  let finished = false;
  const ended = (async () => {
    if (!res.body || res.status !== 200) return;
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const e: SseEvent = { event: 'message', data: undefined, raw: block };
          const data: string[] = [];
          for (const line of block.split('\n')) {
            const c = line.indexOf(':');
            const field = c < 0 ? line : line.slice(0, c);
            const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
            if (field === 'id') e.id = value;
            else if (field === 'event') e.event = value;
            else if (field === 'data') data.push(value);
          }
          // A block without `data:` (a comment such as `: ok`, a lone `retry:`) dispatches no event (WHATWG SSE).
          if (data.length === 0) continue;
          const text = data.join('\n');
          try {
            e.data = JSON.parse(text);
          } catch {
            e.data = text;
          }
          events.push(e);
          wake();
        }
      }
    } catch {
      // aborted by close()
    } finally {
      finished = true;
      wake();
    }
  })();
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  return {
    status: res.status,
    headers: res.headers,
    response: markReal({
      method: 'GET',
      path: '/events/stream',
      status: res.status,
      headers: res.headers,
      contentType,
      body: null,
      text: '',
      bytes: Buffer.alloc(0),
    }),
    events,
    ended,
    async next(type, timeoutMs = 15000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const e = events.find((x) => x.event === type && !consumed.has(x));
        if (e) {
          consumed.add(e);
          return e;
        }
        if (finished) throw new Error(`stream ended without a "${type}" event`);
        const left = until - Date.now();
        if (left <= 0) throw new Error(`no "${type}" event within ${timeoutMs} ms`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, left);
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
    close() {
      abort.abort();
    },
  };
}
