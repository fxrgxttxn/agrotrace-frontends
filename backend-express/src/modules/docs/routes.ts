/**
 * Swagger UI at /api/v1/docs (spec 8.3) over the bundled contract. Every asset is served from swagger-ui-dist in the
 * image (no CDN) and the page has no inline script or style attribute handlers — it works under the gateway's CSP
 * `script-src 'self'` (R89/I6): the initializer is a static file, init.js.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Router, type Response } from 'express';
import type { Container } from '../../container.js';

const require = createRequire(import.meta.url);
const DIST = dirname(require.resolve('swagger-ui-dist/package.json'));

/** Our asset name → [file in swagger-ui-dist, content type]. */
const ASSETS: Record<string, [string, string]> = {
  'swagger-ui.css': ['swagger-ui.css', 'text/css; charset=utf-8'],
  'swagger-ui-bundle.js': ['swagger-ui-bundle.js', 'text/javascript; charset=utf-8'],
  'swagger-ui-standalone-preset.js': ['swagger-ui-standalone-preset.js', 'text/javascript; charset=utf-8'],
  'favicon-32x32.png': ['favicon-32x32.png', 'image/png'],
};

const BASE = '/api/v1/docs';

const INDEX_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>AgroTrace API — Express</title>
<link rel="stylesheet" href="${BASE}/swagger-ui.css">
<link rel="icon" type="image/png" href="${BASE}/favicon-32x32.png">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${BASE}/swagger-ui-bundle.js"></script>
<script src="${BASE}/swagger-ui-standalone-preset.js"></script>
<script src="${BASE}/init.js"></script>
</body>
</html>
`;

const INIT_JS = `window.addEventListener('load', function () {
  window.ui = SwaggerUIBundle({
    url: '${BASE}/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout',
  });
});
`;

/** The page's own policy (also when reached without the gateway, which sets the same one). */
const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; font-src 'self'; frame-ancestors 'none'";

function send(res: Response, type: string, body: string | Buffer, cache: string): void {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', cache);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(body);
}

export function docsRouter(c: Container): Router {
  const r = Router({ caseSensitive: true, strict: true });
  const contract = c.contract?.raw ?? '{}';
  const files = new Map(
    Object.entries(ASSETS).map(([name, [file, type]]) => [
      name,
      { body: readFileSync(join(DIST, file)), type },
    ]),
  );

  r.get('/', (req, res) => {
    // `/api/v1/docs` and `/api/v1/docs/` both serve the page; asset URLs are absolute.
    res.setHeader('Content-Security-Policy', CSP);
    send(res, 'text/html; charset=utf-8', INDEX_HTML, 'no-cache');
  });
  r.get('/init.js', (_req, res) => send(res, 'text/javascript; charset=utf-8', INIT_JS, 'no-cache'));
  r.get('/openapi.json', (_req, res) => send(res, 'application/json; charset=utf-8', contract, 'no-cache'));
  r.get('/:asset', (req, res, next) => {
    const f = files.get(req.params.asset ?? '');
    if (!f) return next();
    send(res, f.type, f.body, 'public, max-age=86400');
  });
  return r;
}
