import { fileURLToPath } from 'node:url';
import { bundle, loadConfig } from '@redocly/openapi-core';
import type { BrowserContext, Page } from '@playwright/test';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ROOT = fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../contracts/redocly.yaml', import.meta.url));

let contract: Json | null = null;

async function load(): Promise<Json> {
  if (!contract) {
    const config = await loadConfig({ configPath: CONFIG });
    contract = (await bundle({ ref: ROOT, config })).bundle.parsed as Json;
  }
  return contract;
}

function deref(doc: Json, node: Json | undefined): Json | undefined {
  let cur = node;
  while (cur && typeof cur['$ref'] === 'string')
    cur = (cur['$ref'] as string)
      .slice(2)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((n: Json, k) => n?.[k], doc);
  return cur;
}

interface Answer {
  status: number;
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

function example(doc: Json, op: Json): Answer {
  const code = Object.keys(op['responses'] ?? {})
    .filter((s) => /^2\d\d$/.test(s))
    .sort()[0];
  const status = Number(code ?? 200);
  const res = deref(doc, op['responses']?.[String(status)]);
  const [contentType, media] = Object.entries<Json>(res?.['content'] ?? {})[0] ?? [undefined, undefined];
  if (!media) return { status };
  const named = media['examples'] ? Object.values<Json>(media['examples']) : [];
  const body = named.length
    ? deref(doc, named[0])?.['value']
    : (media['example'] ?? deref(doc, media['schema'])?.['example']);
  return { status, body, contentType };
}

const FILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#7a8b5c"/><path d="M20 76 36 20M44 76l16-56M64 76l12-40" stroke="#f3eee2" stroke-width="7" stroke-linecap="round" fill="none"/></svg>';

export type Overrides = Record<string, Answer | (() => Answer | undefined)>;

export async function mockApi(
  target: Page | BrowserContext,
  { signedIn = true, overrides = {} }: { signedIn?: boolean; overrides?: Overrides } = {},
): Promise<void> {
  const doc = await load();
  const ops: { method: string; re: RegExp; op: Json; key: string }[] = [];
  for (const [path, item] of Object.entries<Json>(doc['paths']))
    for (const method of ['get', 'post', 'put', 'patch', 'delete'])
      if (item[method])
        ops.push({
          method: method.toUpperCase(),
          re: new RegExp(`^/api/v1${path.replace(/\{\w+\}/g, '[^/]+')}$`),
          op: item[method],
          key: `${method.toUpperCase()} ${path}`,
        });
  ops.sort((a, b) => (a.key.match(/\{/g)?.length ?? 0) - (b.key.match(/\{/g)?.length ?? 0));
  const all: Overrides = {
    ...(signedIn
      ? {}
      : {
          'POST /auth/refresh': {
            status: 401,
            contentType: 'application/problem+json',
            body: {
              type: '/problems/token-expired',
              title: 'Token expired',
              status: 401,
              code: 'TOKEN_EXPIRED',
            },
          },
        }),
    'GET /events/stream': {
      status: 200,
      contentType: 'text/event-stream',
      body: 'retry: 600000\n\nevent: unread\ndata: {"count":3}\n\n',
    },
    ...overrides,
  };
  await target.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (/^\/api\/v1\/(public\/)?files\//.test(url.pathname))
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: FILE_SVG });
    const hit = ops.find((o) => o.method === req.method() && o.re.test(url.pathname));
    if (!hit) return route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{}' });
    const o = all[hit.key];
    const answer = (typeof o === 'function' ? o() : o) ?? example(doc, hit.op);
    const body =
      answer.body === undefined
        ? undefined
        : typeof answer.body === 'string'
          ? answer.body
          : JSON.stringify(answer.body);
    return route.fulfill({
      status: answer.status,
      headers: {
        ...(answer.contentType ? { 'Content-Type': answer.contentType } : {}),
        ...(answer.headers ?? {}),
      },
      body,
    });
  });
}

export async function exampleBody(key: string): Promise<Json> {
  const doc = await load();
  const [method, path] = key.split(' ') as [string, string];
  const op = doc['paths']?.[path]?.[method.toLowerCase()] as Json | undefined;
  if (!op) throw new Error(`No operation ${key}`);
  return structuredClone(example(doc, op).body) as Json;
}
