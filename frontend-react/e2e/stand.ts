import { fileURLToPath } from 'node:url';
import { bundle, loadConfig } from '@redocly/openapi-core';
import type { Page, Route } from '@playwright/test';
import { contractExample, loadContract, operations } from '../test/msw/fromContract';

let loaded = false;
async function ensureContract(): Promise<void> {
  if (loaded) return;
  const root = fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url));
  const configPath = fileURLToPath(new URL('../../contracts/redocly.yaml', import.meta.url));
  const config = await loadConfig({ configPath });
  loadContract((await bundle({ ref: root, config })).bundle.parsed as Record<string, unknown>);
  loaded = true;
}

type Override = unknown | ((url: URL, example: unknown) => unknown);

const IMAGES: Record<string, string> = {
  '2d4f6a8c-0e1a-4b3c-8d5e-7f9a1b3c5d7e': 'products/wheat.jpg',
  'f1a2b3c4-0000-4000-8000-000000000001': 'products/raw-milk.jpg',
  'f1a2b3c4-0000-4000-8000-000000000002': 'products/butter.jpg',
  '8e4a1c2b-7d3f-4a6e-b5c9-2f1e0d9c8b7a': 'logos/petrov.svg',
  'f1a2b3c4-0000-4000-8000-000000000003': 'logos/molkombinat.svg',
  'f1a2b3c4-0000-4000-8000-000000000004': 'logos/provizia.svg',
};

function matcher(path: string): RegExp {
  return new RegExp(`^/api/v1${path.replace(/\{\w+\}/g, '[^/]+')}$`);
}

export async function stand(page: Page, overrides: Record<string, Override> = {}): Promise<void> {
  await ensureContract();
  const ops = operations()
    .filter((o) => o.operationId !== 'streamEvents')
    .sort((a, b) => a.path.split('{').length - b.path.split('{').length);
  await page.route('**/api/v1/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method().toLowerCase();
    if (url.pathname === '/api/v1/events/stream')
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: 'event: unread\ndata: {"count":2}\n\n',
      });
    const file = /^\/api\/v1\/(public\/)?files\/([0-9a-f-]+)$/.exec(url.pathname);
    if (file && method === 'get') {
      const name = IMAGES[file[2]!] ?? (file[1] ? 'logos/petrov.svg' : 'avatars/avatar-1.jpg');
      return route.fulfill({ path: fileURLToPath(new URL(`../../db/seed/images/${name}`, import.meta.url)) });
    }
    const op = ops.find((o) => o.method === method && matcher(o.path).test(url.pathname));
    if (!op) return route.fulfill({ status: 404, body: '' });
    const spec = contractExample(op.operationId);
    const o = overrides[op.operationId];
    const body =
      o === undefined
        ? spec.body
        : typeof o === 'function'
          ? (o as (u: URL, e: unknown) => unknown)(url, spec.body)
          : o;
    if (spec.status === 204 || spec.mediaType === null) return route.fulfill({ status: spec.status });
    return route.fulfill({
      status: spec.status,
      headers: { 'Content-Type': spec.mediaType ?? 'application/json' },
      body: JSON.stringify(body),
    });
  });
}
