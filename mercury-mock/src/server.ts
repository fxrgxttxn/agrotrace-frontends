import http from 'node:http';
import {
  filterVsdList,
  findVsdByUuid,
  InvalidQueryError,
  loadVsdList,
  type Vsd,
} from './store.js';

export interface ServerConfig {
  /** Probability (0..1) that an /api/v1/vsd* request fails with 500. */
  failRate: number;
  /** Delay in ms applied when a request carries `X-Mock-Fail: timeout`. */
  timeoutMs: number;
  /** VSD dataset served by the mock. Defaults to data/vsd.json. */
  data: Vsd[];
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Reads failRate/timeoutMs defaults from the environment (MOCK_FAIL_RATE, MOCK_TIMEOUT_MS). */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<ServerConfig, 'failRate' | 'timeoutMs'> {
  return {
    failRate: clamp01(Number(env.MOCK_FAIL_RATE ?? 0)),
    timeoutMs: Number(env.MOCK_TIMEOUT_MS ?? 30000),
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function methodNotAllowed(res: http.ServerResponse): void {
  sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readMockFailHeader(req: http.IncomingMessage): string | undefined {
  const header = req.headers['x-mock-fail'];
  return Array.isArray(header) ? header[0] : header;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ServerConfig,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://mercury-mock.internal');

  if (url.pathname === '/health') {
    if (req.method !== 'GET') {
      methodNotAllowed(res);
      return;
    }
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // Fail injection (X-Mock-Fail header, MOCK_FAIL_RATE) only applies to the
  // /api/v1/vsd* data endpoints — never to /health (checked above) and never
  // to unknown routes, so a probe against a typo'd path or a health check
  // can't be mistaken for the mock's own simulated outage.
  const vsdListMatch = url.pathname === '/api/v1/vsd';
  const vsdByIdMatch = /^\/api\/v1\/vsd\/([^/]+)$/.exec(url.pathname);
  const isVsdRoute = vsdListMatch || vsdByIdMatch !== null;

  if (isVsdRoute) {
    const mockFail = readMockFailHeader(req);
    if (mockFail === 'timeout') {
      await delay(config.timeoutMs);
    } else if (mockFail === '500') {
      sendJson(res, 500, { error: 'INTERNAL' });
      return;
    } else if (config.failRate > 0 && Math.random() < config.failRate) {
      sendJson(res, 500, { error: 'INTERNAL' });
      return;
    }
  }

  if (vsdListMatch) {
    if (req.method !== 'GET') {
      methodNotAllowed(res);
      return;
    }
    const filters = {
      productCode: url.searchParams.get('productCode') ?? undefined,
      senderInn: url.searchParams.get('senderInn') ?? undefined,
      dateFrom: url.searchParams.get('dateFrom') ?? undefined,
      dateTo: url.searchParams.get('dateTo') ?? undefined,
    };
    try {
      const items = filterVsdList(config.data, filters);
      sendJson(res, 200, { items });
    } catch (err) {
      if (err instanceof InvalidQueryError) {
        sendJson(res, 400, { error: 'BAD_REQUEST' });
        return;
      }
      throw err;
    }
    return;
  }

  if (vsdByIdMatch) {
    if (req.method !== 'GET') {
      methodNotAllowed(res);
      return;
    }
    let uuid: string;
    try {
      uuid = decodeURIComponent(vsdByIdMatch[1]!);
    } catch {
      // Malformed percent-encoding (e.g. an incomplete %-escape) in the uuid
      // segment is a client input error, not a server error.
      sendJson(res, 400, { error: 'BAD_REQUEST' });
      return;
    }
    const found = findVsdByUuid(config.data, uuid);
    if (!found) {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }
    sendJson(res, 200, found);
    return;
  }

  sendJson(res, 404, { error: 'NOT_FOUND' });
}

/** Builds the mock server. Any field left out of `overrides` falls back to the environment / dataset default. */
export function createServer(overrides: Partial<ServerConfig> = {}): http.Server {
  const envConfig = configFromEnv();
  const config: ServerConfig = {
    failRate: overrides.failRate ?? envConfig.failRate,
    timeoutMs: overrides.timeoutMs ?? envConfig.timeoutMs,
    data: overrides.data ?? loadVsdList(),
  };

  return http.createServer((req, res) => {
    handleRequest(req, res, config).catch((err: unknown) => {
      console.error('mercury-mock: unhandled error', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL' });
    });
  });
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const port = Number(process.env.PORT ?? 8080);
  const server = createServer();
  server.listen(port, () => {
    console.log(JSON.stringify({ msg: 'mercury-mock listening', port }));
  });
}
