/** fetch with the shared-cookie behaviour a browser would have across the two backends (same site behind the gateway). */
import type { Target } from './backends.js';

export interface Session {
  accessToken: string | null;
  /** `at_refresh` cookie value (Path=/api/v1/auth on both backends). */
  refresh: string | null;
}

/**
 * fetch that waits out a 429 (Retry-After, at most 3 times): tests/cross runs against the plain backends (no
 * RATE_LIMIT_OVERRIDES) and a port runs its pair in both orders back to back, so the shared `login-ip` / `user` windows
 * (R30, one Redis for every backend) must not fail a scenario that does not test rate limits.
 */
export async function fetchRetrying(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    const wait = Number(res.headers.get('retry-after'));
    if (res.status !== 429 || attempt >= 3 || !(wait > 0 && wait <= 60)) return res;
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, wait * 1000 + 250));
  }
}

export async function call(
  t: Target,
  s: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> | null }> {
  const headers = new Headers();
  if (s.accessToken) headers.set('authorization', `Bearer ${s.accessToken}`);
  if (s.refresh && path.startsWith('/auth/')) headers.set('cookie', `at_refresh=${s.refresh}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const res = await fetchRetrying(t.url + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) {
    const m = /^at_refresh=([^;]*)/.exec(c);
    if (m) s.refresh = m[1] || null;
  }
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}
