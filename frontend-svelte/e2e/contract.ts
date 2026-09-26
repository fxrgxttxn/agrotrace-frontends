import { fileURLToPath } from 'node:url';
import { bundle, loadConfig } from '@redocly/openapi-core';
import type { BrowserContext, Route } from '@playwright/test';
import { contractExample, loadContract, operations, type ContractOperation } from '../test/msw/fromContract';

// Browser-side API for the e2e specs until the shared mock backend (@agrotrace/mock-api) is in this branch: every
// `/api/v1/*` request of the page is answered with the contract's own example of its operation (the same generator as
// the component tests, test/msw/fromContract.ts), overridable per operation. The SSE stream answers one `unread`.

const ROOT = fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../contracts/redocly.yaml', import.meta.url));
const PHOTO = fileURLToPath(new URL('../../db/seed/images/avatars/avatar-1.jpg', import.meta.url));
loadContract((await bundle({ ref: ROOT, config: await loadConfig({ configPath: CONFIG }) })).bundle.parsed);

export { contractExample };

export interface Override {
  status?: number;
  example?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Answer this way only the first time, then the default. */
  once?: boolean;
  /** Answer this way this many times, then the default. */
  times?: number;
  /** No answer at all: the network fails (a transient failure). */
  abort?: boolean;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ROUTES: { op: ContractOperation; re: RegExp; rank: number[] }[] = operations()
  .map((op) => ({
    op,
    re: new RegExp(
      `^/api/v1${op.path
        .split(/\{\w+\}/)
        .map(esc)
        .join('[^/]+')}$`,
    ),
    rank: op.path.split('/').map((s) => (s.startsWith('{') ? 1 : 0)),
  }))
  .sort((a, b) => {
    for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) {
      const d = (a.rank[i] ?? -1) - (b.rank[i] ?? -1);
      if (d) return d;
    }
    return 0;
  });

/** Answers the page's API calls from the contract; `overrides` by operationId. Returns the list of calls made. */
export async function mockApi(
  context: BrowserContext,
  initial: Record<string, Override> = {},
): Promise<string[]> {
  const overrides = { ...initial };
  const calls: string[] = [];
  await context.route('**/api/v1/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const hit = ROUTES.find((r) => r.op.method === req.method().toLowerCase() && r.re.test(url.pathname));
    if (!hit) return route.fulfill({ status: 404, body: '' });
    calls.push(`${req.method()} ${url.pathname}`);
    if (hit.op.operationId === 'streamEvents')
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
        body: 'retry: 60000\nevent: unread\ndata: {"count":3}\n\n',
      });
    // File URLs of the examples (signed: avatar; public: logo, product photo): a seed photo, so pages show a real image.
    if (hit.op.operationId === 'downloadFile' || hit.op.operationId === 'downloadPublicFile')
      return route.fulfill({ status: 200, contentType: 'image/jpeg', path: PHOTO });
    const o = overrides[hit.op.operationId] ?? {};
    const left = o.once ? 1 : o.times;
    if (left !== undefined) {
      if (left <= 1) delete overrides[hit.op.operationId];
      else overrides[hit.op.operationId] = { ...o, once: false, times: left - 1 };
    }
    if (o.abort) return route.abort('failed');
    const spec = contractExample(hit.op.operationId, o.status, o.example);
    const body = o.body !== undefined ? o.body : spec.body;
    return route.fulfill({
      status: spec.status,
      headers: {
        ...spec.headers,
        ...o.headers,
        ...(spec.mediaType ? { 'Content-Type': spec.mediaType } : {}),
      },
      body: body === null || body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
    });
  });
  return calls;
}

/** No session: the start-up refresh answers 401 (the mock backend without a cookie). */
export const ANONYMOUS: Record<string, Override> = { refreshToken: { status: 401 } };
