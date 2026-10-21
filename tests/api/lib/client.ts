/**
 * Minimal HTTP client over fetch with a cookie jar (the refresh cookie `at_refresh`, Path=/api/v1/auth). Tests talk
 * to the backend only through this — never through backend code (Global Constraints).
 */
import { randomBytes } from 'node:crypto';
import { API_URL } from './env.js';
import { markReal, recordCall } from './registry.js';

export interface ApiResponse {
  method: string;
  /** Path relative to API_URL, with the query string (`/health/live`). */
  path: string;
  status: number;
  headers: Headers;
  /** Media type without parameters (`application/problem+json`), '' when absent. */
  contentType: string;
  /** Parsed JSON for JSON media types, otherwise the text; null for an empty body. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bodies are checked by expectContract, tests read fields
  body: any;
  text: string;
  bytes: Buffer;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** JSON-serialized unless it is a string or bytes (sent as is). */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

interface StoredCookie {
  value: string;
  path: string;
  expires: number | null;
}

/** RFC 6265 subset: name=value, Path, Max-Age/Expires. `Secure` is ignored — the test network is plain HTTP. */
export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  store(setCookie: string[], requestPath: string, now = Date.now()): void {
    for (const line of setCookie) {
      const [pair = '', ...attrs] = line.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      // Default-path (RFC 6265 5.1.4): the request path up to, not including, its last '/'.
      let path = requestPath.replace(/\/[^/]*$/, '') || '/';
      let expires: number | null = null;
      let maxAge = false;
      for (const a of attrs) {
        const i = a.indexOf('=');
        const key = (i < 0 ? a : a.slice(0, i)).toLowerCase();
        const val = i < 0 ? '' : a.slice(i + 1);
        if (key === 'path' && val.startsWith('/')) path = val;
        if (key === 'max-age') {
          expires = now + Number(val) * 1000;
          maxAge = true;
        }
        if (key === 'expires' && !maxAge) expires = Date.parse(val);
      }
      if (expires !== null && expires <= now) this.cookies.delete(name);
      else this.cookies.set(name, { value, path, expires });
    }
  }

  /** `Cookie` header value for an absolute request path, or null. */
  header(requestPath: string, now = Date.now()): string | null {
    const out: string[] = [];
    for (const [name, c] of this.cookies) {
      if (c.expires !== null && c.expires <= now) continue;
      const dir = c.path.endsWith('/') ? c.path : `${c.path}/`;
      if (requestPath === c.path || requestPath.startsWith(dir)) out.push(`${name}=${c.value}`);
    }
    return out.length ? out.join('; ') : null;
  }

  get(name: string): string | undefined {
    return this.cookies.get(name)?.value;
  }
}

/**
 * A fresh client address for `X-Forwarded-For`. The backends take the client IP from the last `X-Forwarded-For` entry
 * (one trusted proxy hop — the gateway appends the real peer address); tests talk to api-<backend> directly, so each
 * client plays its own "browser" with an address of its own. Per-IP limits (`login-ip`, R30) therefore count per
 * client: suites never share a login-ip window by accident, and rate-limit tests isolate their subject.
 */
export function randomClientIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${(b[2]! % 254) + 1}`;
}

export class ApiClient {
  readonly jar = new CookieJar();
  accessToken: string | null = null;
  /** Sent as `X-Forwarded-For` unless a request sets its own. */
  clientIp: string = randomClientIp();

  constructor(readonly baseUrl: string = API_URL) {}

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const headers = new Headers(opts.headers);
    if (this.accessToken && !headers.has('authorization'))
      headers.set('authorization', `Bearer ${this.accessToken}`);
    if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', this.clientIp);
    const cookie = this.jar.header(url.pathname);
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
    let body: string | Uint8Array | undefined;
    if (opts.body !== undefined) {
      if (typeof opts.body === 'string' || opts.body instanceof Uint8Array) body = opts.body;
      else {
        body = JSON.stringify(opts.body);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
    }
    const res = await fetch(url, { method, headers, body, redirect: 'manual' });
    this.jar.store(res.headers.getSetCookie(), url.pathname);
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    let parsed: unknown = text.length ? text : null;
    if (text.length && /^application\/(.+\+)?json$/.test(contentType)) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text; // expectContract reports the mismatch
      }
    }
    const rel = url.pathname.slice(new URL(this.baseUrl).pathname.length) + url.search;
    recordCall({ method, path: rel, status: res.status });
    return markReal({
      method,
      path: rel,
      status: res.status,
      headers: res.headers,
      contentType,
      body: parsed,
      text,
      bytes,
    });
  }

  get = (path: string, opts?: RequestOptions) => this.request('GET', path, opts);
  post = (path: string, body?: unknown, opts: RequestOptions = {}) =>
    this.request('POST', path, { ...opts, body });
  put = (path: string, body?: unknown, opts: RequestOptions = {}) =>
    this.request('PUT', path, { ...opts, body });
  patch = (path: string, body?: unknown, opts: RequestOptions = {}) =>
    this.request('PATCH', path, { ...opts, body });
  delete = (path: string, opts?: RequestOptions) => this.request('DELETE', path, opts);
}

/** An anonymous client (no token); `loginAs` (auth.ts) returns a signed-in one. */
export function api(): ApiClient {
  return new ApiClient();
}
