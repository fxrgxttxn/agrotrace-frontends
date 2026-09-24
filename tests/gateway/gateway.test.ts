// Fetches the gateway (service name `gateway` on the compose `at` network) with a spoofed Host
// header, exactly the way a browser resolving *.localhost DNS to 127.0.0.1 would see it. Run via
// `./at.sh up gateway && ./at.sh gw:test` — no api-<back> container is ever started here: every
// 502 case below proves the gateway starts and keeps working with zero backends running (R6).
//
// The one case NOT covered here is proxy_buffering/proxy_read_timeout on /api/v1/events/ (SSE):
// the `tools` container this suite runs in has no docker socket, so it cannot `exec` into the
// gateway container to run `nginx -T`, and standing up a real upstream just to observe streaming
// behaviour would mean adding a permanent extra compose service whose name (api-express, ...)
// later plans need for the real backends. `./at.sh gw:test` therefore greps `nginx -T` from the
// host (in at.sh, which already runs other `docker compose exec` assertions) before it runs this
// suite — see the `gw:test)` case in at.sh.
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import problem502 from '../../gateway/problem-502.json';

const FRONTS = ['react', 'angular', 'svelte'] as const;
const BACKS = ['express', 'django', 'laravel'] as const;

interface SimpleResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

// fetch() silently drops a caller-set `Host` header (it's on the WHATWG forbidden-header list),
// which makes it useless for virtual-host testing: every request would land on default_server
// regardless of the Host we asked for. node:http has no such restriction, so it's used directly
// to actually reach {front}-{back}.localhost / localhost / foo.localhost on the gateway service.
function fetchAs(
  host: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request(
      {
        host: 'gateway',
        port: 80,
        path,
        method: opts.method ?? 'GET',
        headers: {
          Host: host,
          ...(opts.body ? { 'Content-Length': String(opts.body.length) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          settled = true;
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              get: (name: string) => {
                const v = res.headers[name.toLowerCase()];
                return Array.isArray(v) ? v.join(', ') : (v ?? null);
              },
            },
            text: async () => buf.toString('utf8'),
            json: async () => JSON.parse(buf.toString('utf8')),
          });
        });
      },
    );
    // A large-body request can have nginx answer 413 and close the connection before the write
    // finishes; once we already have a full response, a late write-side ECONNRESET is expected
    // and harmless, not a test failure.
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('gateway: 9 frontend x backend combinations', () => {
  for (const front of FRONTS) {
    for (const back of BACKS) {
      const host = `${front}-${back}.localhost`;

      it(`GET / on ${host} serves the ${front} placeholder with X-Frontend`, async () => {
        const res = await fetchAs(host, '/');
        expect(res.status).toBe(200);
        expect(res.headers.get('x-frontend')).toBe(front);
        expect(await res.text()).toContain('<div id="app">');
      });

      it(`GET /batches/123 on ${host} falls back to index.html (SPA deep route)`, async () => {
        const res = await fetchAs(host, '/batches/123');
        expect(res.status).toBe(200);
        expect(res.headers.get('x-frontend')).toBe(front);
        expect(await res.text()).toContain('<div id="app">');
      });

      it(`GET /api/v1/health/live on ${host} is 502 BACKEND_UNAVAILABLE (no backend running)`, async () => {
        const res = await fetchAs(host, '/api/v1/health/live');
        expect(res.status).toBe(502);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        const body = await res.json();
        expect(body.status).toBe(502);
        expect(body.code).toBe('BACKEND_UNAVAILABLE');
        expect(body.type).toBe(problem502.type);
        expect(body.title).toBe(problem502.title);
        expect(body.params).toEqual({ backend: back });
      });
    }
  }
});

describe('gateway: security headers', () => {
  it('sets X-Content-Type-Options, Referrer-Policy and a CSP on an SPA host', async () => {
    const res = await fetchAs('react-express.localhost', '/');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('sets the same headers on the start page and on a 502', async () => {
    const start = await fetchAs('localhost', '/');
    expect(start.headers.get('x-content-type-options')).toBe('nosniff');
    expect(start.headers.get('content-security-policy')).toContain("default-src 'self'");

    const down = await fetchAs('react-express.localhost', '/api/v1/health/live');
    expect(down.headers.get('x-content-type-options')).toBe('nosniff');
    expect(down.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('forwards a client X-Request-Id, or generates one when absent', async () => {
    const withRid = await fetchAs('react-express.localhost', '/', {
      headers: { 'X-Request-Id': 'test-rid-123' },
    });
    expect(withRid.headers.get('x-request-id')).toBe('test-rid-123');

    const withoutRid = await fetchAs('react-express.localhost', '/');
    expect(withoutRid.headers.get('x-request-id')).toBeTruthy();
    expect(withoutRid.headers.get('x-request-id')).not.toBe('test-rid-123');
  });
});

describe('gateway: cache headers', () => {
  it('serves index.html with Cache-Control: no-cache', async () => {
    const res = await fetchAs('react-express.localhost', '/index.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves /assets/* with a long, immutable cache lifetime', async () => {
    // The path need not exist for the header to prove the policy: /assets/ has no SPA fallback
    // (unlike /), so a missing hashed asset is a plain 404, still carrying the cache header.
    const res = await fetchAs('react-express.localhost', '/assets/does-not-exist.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
});

describe('gateway: 413 body too large', () => {
  it('answers an over-limit body with problem+json FILE_TOO_LARGE (R34, client_max_body_size 12m)', async () => {
    const oversized = Buffer.alloc(13 * 1024 * 1024, 'a'); // > 12m, comfortably over the 10 MB lab protocol
    const res = await fetchAs('react-express.localhost', '/api/v1/lab-tests', {
      method: 'POST',
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    expect(body.status).toBe(413);
    expect(body.code).toBe('FILE_TOO_LARGE');
  });
});

describe('gateway: /_health/<back> (polled by the start page)', () => {
  it('reports status:fail while no backend is running, for all three backends', async () => {
    for (const back of BACKS) {
      const res = await fetchAs('localhost', `/_health/${back}`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'fail' });
    }
  });
});

describe('gateway: start page and unknown hosts', () => {
  it('http://localhost/ lists all 9 combinations as links', async () => {
    const res = await fetchAs('localhost', '/');
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const front of FRONTS) {
      for (const back of BACKS) {
        expect(body).toContain(`http://${front}-${back}.localhost/`);
      }
    }
  });

  it('an unrecognised *.localhost host falls back to the start page (default_server)', async () => {
    const res = await fetchAs('foo.localhost', '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Реализации');
  });
});

describe('gateway: design-system showcase at /_ds/', () => {
  it('redirects /_ds/ to the showcase index', async () => {
    const res = await fetchAs('localhost', '/_ds/');
    expect([301, 302, 303, 307, 308]).toContain(res.status);
    expect(res.headers.get('location')).toContain('/_ds/showcase/index.html');
  });

  it('serves the showcase page and the design tokens/css read-only from the bind mount', async () => {
    const index = await fetchAs('localhost', '/_ds/showcase/index.html');
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('Поле');

    const css = await fetchAs('localhost', '/_ds/index.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');

    const font = await fetchAs('localhost', '/_ds/fonts/onest-latin-400-normal.woff2');
    expect(font.status).toBe(200);
  });
});
