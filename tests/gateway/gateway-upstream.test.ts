// Pass-through behaviour that needs a real backend to actually respond (unlike gateway.test.ts,
// which only ever sees "no backend running"). Requires the `gwtest` compose profile's stub
// upstream (gateway/test/stub-upstream.mjs, network-aliased `api-express`) to be running — brought
// up and torn down by `./at.sh gw:test` (gw_test() in at.sh). Only react-express.localhost /
// angular-express.localhost / svelte-express.localhost actually reach the stub; django/laravel
// still have no backend and are covered by gateway.test.ts.
//
// This is fix round 1's regression coverage for the bug the independent review found: with
// `proxy_intercept_errors on`, nginx was rewriting a real backend's own 503/413 responses into the
// gateway's generic problem+json, discarding the backend's actual body (e.g. params.maxBytes).
import { describe, expect, it } from 'vitest';
import { fetchAs, streamAs } from './lib/fetch-as';

const HOST = 'react-express.localhost';

describe('gateway-upstream: real backend responses pass through unchanged', () => {
  it('a backend 503 (health/ready degraded) reaches the client exactly as sent, not rewritten to 502', async () => {
    const res = await fetchAs(HOST, '/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.getAll('x-request-id')).toHaveLength(1);
    const body = (await res.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('fail');
    expect(body.checks).toEqual({ db: 'ok', redis: 'ok', rabbitmq: 'fail', s3: 'ok' });
  });

  it("a backend 413 keeps its own params (maxBytes), distinct from the gateway's own 413", async () => {
    const res = await fetchAs(HOST, '/api/v1/lab-tests/oversized', { method: 'POST' });
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.getAll('x-request-id')).toHaveLength(1);
    const body = (await res.json()) as { code: string; params: { maxBytes: number } };
    expect(body.code).toBe('FILE_TOO_LARGE');
    // The backend's own limit (10 MB), NOT the gateway's client_max_body_size one (12582912) —
    // proves this body came from the backend, not from @too_large.
    expect(body.params).toEqual({ maxBytes: 10485760 });
  });

  it('a backend 200 passes through with a single X-Request-Id, no duplicate from the gateway', async () => {
    const res = await fetchAs(HOST, '/api/v1/whatever');
    expect(res.status).toBe(200);
    expect(res.headers.getAll('x-request-id')).toHaveLength(1);
    expect(res.headers.getAll('x-content-type-options')).toHaveLength(1);
  });

  it('/_health/express (start page polling) sees the stub as live, status:ok — not the synthesized 503', async () => {
    const res = await fetchAs('localhost', '/_health/express');
    expect(res.status).toBe(200);
    expect(res.headers.getAll('x-request-id')).toHaveLength(1);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('gateway-upstream: X-Request-Id validation and forwarding', () => {
  it('forwards a valid client X-Request-Id upstream unchanged', async () => {
    const res = await fetchAs(HOST, '/api/v1/whatever', {
      headers: { 'X-Request-Id': 'client-valid-id.123' },
    });
    expect(res.headers.getAll('x-request-id')).toEqual(['client-valid-id.123']);
  });

  it('replaces an invalid client X-Request-Id (bad characters) with a generated one before forwarding', async () => {
    const res = await fetchAs(HOST, '/api/v1/whatever', { headers: { 'X-Request-Id': 'has spaces/slash' } });
    const ids = res.headers.getAll('x-request-id');
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe('has spaces/slash');
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('replaces an invalid client X-Request-Id (too long) with a generated one before forwarding', async () => {
    const res = await fetchAs(HOST, '/api/v1/whatever', { headers: { 'X-Request-Id': 'x'.repeat(65) } });
    const ids = res.headers.getAll('x-request-id');
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates one when the client sends none', async () => {
    const res = await fetchAs(HOST, '/api/v1/whatever');
    const ids = res.headers.getAll('x-request-id');
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('gateway-upstream: X-Forwarded-*', () => {
  it('sets X-Forwarded-Host to the raw Host header (port kept) and X-Forwarded-Port/-Proto/-For', async () => {
    const res = await fetchAs('react-express.localhost:8088', '/api/v1/whatever');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forwardedHost: string | null;
      forwardedPort: string | null;
      forwardedProto: string | null;
      forwardedFor: string | null;
      host: string | null;
    };
    // Host forwarded to the backend is $host (port stripped, unchanged from before this fix
    // round) — only X-Forwarded-Host ($http_host) is new and carries the port.
    expect(body.host).toBe('react-express.localhost');
    expect(body.forwardedHost).toBe('react-express.localhost:8088');
    // The container always listens on 80 internally, regardless of the published host port.
    expect(body.forwardedPort).toBe('80');
    expect(body.forwardedProto).toBe('http');
    expect(body.forwardedFor).toBeTruthy();
  });
});

describe('gateway-upstream: SSE actually streams unbuffered', () => {
  it('delivers two events roughly 1 s apart, not both at once when the connection closes', async () => {
    const { status, chunks } = await streamAs(HOST, '/api/v1/events/stream');
    expect(status).toBe(200);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const joined = chunks.map((c) => c.text).join('');
    expect(joined).toContain('"n":1');
    expect(joined).toContain('"n":2');

    // Chunk carrying the second event must arrive well after the first — proxy_buffering off
    // means nginx forwards each write as it comes, not just once at the very end.
    const firstAt = chunks.find((c) => c.text.includes('"n":1'))!.at;
    const secondAt = chunks.find((c) => c.text.includes('"n":2'))!.at;
    expect(secondAt - firstAt).toBeGreaterThan(700);
  }, 10000);
});
