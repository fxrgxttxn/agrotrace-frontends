/**
 * Stand helpers of the cross scenarios, HTTP only: a fetch wrapper for any body (JSON, multipart, bytes), the Mailpit
 * reader (the SMTP sink both backends send to) and a minimal Server-Sent Events reader (GET /events/stream).
 */
import { randomBytes } from 'node:crypto';
import type { Target } from './backends.js';
import { fetchRetrying } from './http.js';

export interface Res {
  status: number;
  headers: Headers;
  bytes: Buffer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked field by field by the scenarios
  body: any;
}

/** One request to `t`: JSON `json`, or raw `body` with `contentType`; `token` → Bearer. */
export async function send(
  t: Target,
  method: string,
  path: string,
  opts: {
    token?: string;
    json?: unknown;
    body?: Buffer;
    contentType?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Res> {
  const headers = new Headers(opts.headers);
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
  let body: Buffer | string | undefined = opts.body;
  if (opts.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(opts.json);
  } else if (opts.contentType) headers.set('content-type', opts.contentType);
  const res = await fetchRetrying(t.url + path, { method, headers, body });
  const bytes = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  let parsed: unknown = null;
  if (/json/.test(type) && bytes.length > 0) parsed = JSON.parse(bytes.toString('utf8'));
  return { status: res.status, headers: res.headers, bytes, body: parsed };
}

/** A multipart/form-data body with one `file` part. */
export function filePart(data: Buffer, filename: string, contentType: string) {
  const boundary = `----agrotrace${randomBytes(12).toString('hex')}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  return {
    body: Buffer.concat([Buffer.from(head), data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const MAILPIT_URL = (process.env.MAILPIT_URL ?? 'http://mailpit:8025').replace(/\/$/, '');

/** The token of the single `/{kind}/{token}` link (R82) in the newest letter to `address` (polls up to 10 s). */
export async function mailedToken(address: string, kind: 'invite' | 'password/reset'): Promise<string> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const found = (await (
      await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)
    ).json()) as { messages: { ID: string }[] };
    if (found.messages.length > 0) {
      const mail = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${found.messages[0]!.ID}`)).json()) as {
        Text: string;
      };
      const links = [
        ...mail.Text.matchAll(new RegExp(`https?://\\S+?/${kind}/([A-Za-z0-9_-]+)(?=\\s|$)`, 'g')),
      ];
      if (links.length !== 1) throw new Error(`expected one ${kind} link in the letter to ${address}`);
      return links[0]![1]!;
    }
    if (Date.now() > deadline) throw new Error(`no letter to ${address} within 10 s`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface SseEvent {
  id?: string;
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked by the scenarios
  data: any;
}

export interface Stream {
  status: number;
  headers: Headers;
  events: SseEvent[];
  /** The next unconsumed event of `type` matching `pred` (waits up to `timeoutMs`). */
  next(type: string, pred?: (e: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  close(): void;
}

/** GET /events/stream?access_token= on `t` (what a browser EventSource does). */
export async function openStream(t: Target, token: string): Promise<Stream> {
  const abort = new AbortController();
  const res = await fetch(`${t.url}/events/stream?access_token=${encodeURIComponent(token)}`, {
    headers: { accept: 'text/event-stream' },
    signal: abort.signal,
  });
  const events: SseEvent[] = [];
  const consumed = new Set<SseEvent>();
  let finished = false;
  void (async () => {
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
          const e: SseEvent = { event: 'message', data: undefined };
          const data: string[] = [];
          for (const line of block.split('\n')) {
            const c = line.indexOf(':');
            const field = c < 0 ? line : line.slice(0, c);
            const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
            if (field === 'id') e.id = value;
            else if (field === 'event') e.event = value;
            else if (field === 'data') data.push(value);
          }
          if (data.length === 0) continue;
          try {
            e.data = JSON.parse(data.join('\n'));
          } catch {
            e.data = data.join('\n');
          }
          events.push(e);
        }
      }
    } catch {
      // aborted by close()
    } finally {
      finished = true;
    }
  })();
  return {
    status: res.status,
    headers: res.headers,
    events,
    async next(type, pred = () => true, timeoutMs = 20000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const e = events.find((x) => x.event === type && !consumed.has(x) && pred(x));
        if (e) {
          consumed.add(e);
          return e;
        }
        if (finished) throw new Error(`stream ended without a "${type}" event`);
        if (Date.now() > until) throw new Error(`no "${type}" event within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    close() {
      abort.abort();
    },
  };
}
