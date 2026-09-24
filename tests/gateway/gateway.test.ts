// Fetches the gateway (service name `gateway` on the compose `at` network) with a spoofed Host
// header, exactly the way a browser resolving *.localhost DNS to 127.0.0.1 would see it. Run via
// `./at.sh up gateway && ./at.sh gw:test` — `gw:test` always brings up the gwtest-profile stub,
// network-aliased `api-express` (gateway-upstream.test.ts), so react-express.localhost /
// angular-express.localhost / svelte-express.localhost actually have a live backend to reach; the
// "no backend running" (502 BACKEND_UNAVAILABLE) cases below are therefore only true for
// django/laravel. See gateway-upstream.test.ts for what a live backend's own responses look like.
//
// Two things NOT covered here: (1) proxy_buffering/proxy_read_timeout on /api/v1/events/ and the
// absence of proxy_intercept_errors — the `tools` container this suite runs in has no docker
// socket, so it cannot `exec` into the gateway container to run `nginx -T`; `./at.sh gw:test`
// greps that from the host instead (see gw_test() in at.sh). (2) SSE actually streaming
// unbuffered — see gateway-upstream.test.ts, which has a real upstream to stream from.
import { describe, expect, it } from 'vitest';
import problem502 from '../../gateway/problem-502.json';
import { fetchAs } from './lib/fetch-as';

const FRONTS = ['react', 'angular', 'svelte'] as const;
const BACKS = ['express', 'django', 'laravel'] as const;
const BACKS_WITHOUT_BACKEND = ['django', 'laravel'] as const;

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
    }
  }

  for (const front of FRONTS) {
    for (const back of BACKS_WITHOUT_BACKEND) {
      const host = `${front}-${back}.localhost`;

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

    // react-django (not react-express): during gw:test, express has the stub upstream running,
    // so only django/laravel are guaranteed to actually be a 502 here.
    const down = await fetchAs('react-django.localhost', '/api/v1/health/live');
    expect(down.status).toBe(502);
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

  it('serves an existing /assets/ file with a long, immutable cache lifetime', async () => {
    // placeholder/assets/placeholder.js is baked into every /srv/<front> (Dockerfile) precisely
    // so there is a real file to assert this against, not just the 404 case below.
    const res = await fetchAs('react-express.localhost', '/assets/placeholder.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frontend')).toBe('react');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toContain('export {}');
  });

  it('404s (not the SPA fallback) for a missing /assets/ file, still carrying the cache header', async () => {
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
    expect(body.title).toBe('File too large');
    // 12m = 12 * 1024 * 1024 — the gateway's own limit, distinct from any backend-imposed one
    // (see gateway-upstream.test.ts, which asserts a *different* maxBytes survives pass-through).
    expect(body.params).toEqual({ maxBytes: 12582912 });
  });
});

describe('gateway: /_health/<back> (polled by the start page)', () => {
  it('reports status:fail while no backend is running (django, laravel — express has the stub, see gateway-upstream.test.ts)', async () => {
    for (const back of BACKS_WITHOUT_BACKEND) {
      const res = await fetchAs('localhost', `/_health/${back}`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'fail' });
    }
  });

  it('falls back to the start page for a backend name outside {express,django,laravel}', async () => {
    // No location matches /_health/nope, so it falls through to default_server's own SPA-style
    // catch-all (try_files ... /index.html) — documented here as the actual, accepted behaviour,
    // not a dedicated 404.
    const res = await fetchAs('localhost', '/_health/nope');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Реализации');
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

    const sprite = await fetchAs('localhost', '/_ds/sprite.svg');
    expect(sprite.status).toBe(200);

    const illustration = await fetchAs('localhost', '/_ds/illustrations/not-found.svg');
    expect(illustration.status).toBe(200);

    const component = await fetchAs('localhost', '/_ds/components/button.css');
    expect(component.status).toBe(200);

    const manifest = await fetchAs('localhost', '/_ds/icons/manifest.json');
    expect(manifest.status).toBe(200);
  });

  it('does not expose anything outside the narrowed allowlist (node_modules, scripts, package.json, raw icons)', async () => {
    for (const path of [
      '/_ds/package.json',
      '/_ds/README.md',
      '/_ds/scripts/build-sprite.ts',
      '/_ds/test/contrast.test.ts',
      '/_ds/node_modules/.bin/vitest',
      '/_ds/icons/alert.svg',
    ]) {
      const res = await fetchAs('localhost', path);
      expect(res.status, path).toBe(404);
    }
  });

  it('is not reachable from an SPA host — /_ds/ only exists on the default_server', async () => {
    const res = await fetchAs('react-express.localhost', '/_ds/showcase/index.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frontend')).toBe('react');
    // Falls through to that host's own location / (SPA fallback), not the design-system alias.
    expect(await res.text()).toContain('<div id="app">');
  });
});
