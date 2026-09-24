// Tiny stand-in for a real api-<back> service, used only by `./at.sh gw:test` (compose profile
// `gwtest`, network alias `api-express`). Zero dependencies (node:http only) — exercises exactly
// the pass-through behaviour fix round 1 is about: the gateway must forward a real backend's own
// status code, body and X-Request-Id unchanged, not rewrite them into its own problem+json (that
// was the bug `proxy_intercept_errors on` caused).
import http from 'node:http';

const PORT = 8000;

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://stub-upstream');
    const reqId = req.headers['x-request-id'] || '';

    // Contract-shaped 503 (health/ready degraded): must reach the client exactly as sent, not be
    // rewritten into the gateway's 502 BACKEND_UNAVAILABLE.
    if (url.pathname === '/api/v1/health/ready') {
      res.writeHead(503, { 'Content-Type': 'application/json', 'X-Request-Id': reqId });
      res.end(
        JSON.stringify({ status: 'fail', checks: { db: 'ok', redis: 'ok', rabbitmq: 'fail', s3: 'ok' } }),
      );
      return;
    }

    // The `/_health/<back>` liveness check the start page polls — a genuine 200 {status:"ok"}.
    if (url.pathname === '/api/v1/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': reqId });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // A backend-issued 413 with its own params — must reach the client with params.maxBytes
    // intact, not be replaced by the gateway's own (different) 413 body.
    if (url.pathname === '/api/v1/lab-tests/oversized') {
      res.writeHead(413, { 'Content-Type': 'application/problem+json', 'X-Request-Id': reqId });
      res.end(
        JSON.stringify({
          type: '/problems/file-too-large',
          title: 'File too large',
          status: 413,
          code: 'FILE_TOO_LARGE',
          params: { maxBytes: 10485760 },
        }),
      );
      return;
    }

    // SSE: two events a second apart, to prove proxy_buffering off actually delivers them as
    // separate chunks instead of nginx holding the whole response until the connection closes.
    if (url.pathname === '/api/v1/events/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Request-Id': reqId,
      });
      res.write('data: {"n":1}\n\n');
      const timer = setTimeout(() => {
        res.write('data: {"n":2}\n\n');
        res.end();
      }, 1000);
      req.on('close', () => clearTimeout(timer));
      return;
    }

    // Default: plain 200, echoing the request id back exactly like a real backend would (per
    // contract, X-Request-Id on every response) — this is what makes header-duplication bugs
    // observable. Also echoes the forwarding headers it received, so tests can assert on them
    // without the gateway needing to expose them itself.
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': reqId });
    res.end(
      JSON.stringify({
        ok: true,
        path: url.pathname,
        forwardedHost: req.headers['x-forwarded-host'] || null,
        forwardedPort: req.headers['x-forwarded-port'] || null,
        forwardedProto: req.headers['x-forwarded-proto'] || null,
        forwardedFor: req.headers['x-forwarded-for'] || null,
        host: req.headers['host'] || null,
      }),
    );
  })
  .listen(PORT, () => {
    console.log(`stub upstream listening on ${PORT}`);
  });
