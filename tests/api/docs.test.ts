/**
 * Swagger UI at /api/v1/docs (spec 8.3) over the bundled contract, self-hosted and CSP-compatible (R89/I6): no CDN,
 * no inline script, every referenced asset served by the backend itself.
 */
import { describe, expect, it } from 'vitest';
import { api } from './lib/client.js';
import { contract } from './lib/contract.js';
import { API_BACKEND, API_URL } from './lib/env.js';

const origin = new URL(API_URL).origin;

async function fetchAbs(path: string) {
  const res = await fetch(origin + path);
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    backend: res.headers.get('x-backend'),
    text: await res.text(),
  };
}

describe('GET /docs', () => {
  it('serves the Swagger UI page without inline scripts or external origins', async () => {
    const res = await api().get('/docs');
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('text/html');
    expect(res.headers.get('x-backend')).toBe(API_BACKEND);
    const html = res.text;
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, inner] of scripts) {
      expect(attrs).toMatch(/\bsrc="\/[^"]+"/); // same-origin file, never inline
      expect(inner!.trim()).toBe('');
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // no inline event handlers
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//i); // no other origin / CDN
  });

  it('every asset the page references is served (JS as JavaScript, CSS as CSS)', async () => {
    const html = (await api().get('/docs')).text;
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const ref of refs) {
      const a = await fetchAbs(ref);
      expect(a.status, ref).toBe(200);
      expect(a.backend, ref).toBe(API_BACKEND);
      if (ref.endsWith('.js')) expect(a.type, ref).toMatch(/javascript/);
      if (ref.endsWith('.css')) expect(a.type, ref).toMatch(/text\/css/);
    }
  });

  it('the initializer loads the bundled contract, which equals contracts/openapi.yaml', async () => {
    const html = (await api().get('/docs')).text;
    const init = [...html.matchAll(/<script\b[^>]*src="(\/[^"]+)"/g)]
      .map((m) => m[1]!)
      .find((s) => /init/.test(s))!;
    const initJs = (await fetchAbs(init)).text;
    const url = /url:\s*'([^']+)'/.exec(initJs)?.[1];
    expect(url).toBeTruthy();
    const served = await fetchAbs(url!);
    expect(served.status).toBe(200);
    expect(served.type).toMatch(/application\/json/);
    expect(JSON.parse(served.text)).toEqual((await contract()).doc);
  });
});
