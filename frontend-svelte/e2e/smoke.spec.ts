import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { cabinetOnly, CABINET_MODULE, nodeCounts, publicModules, publicNotAllowed } from './chunks';
import { ANONYMOUS, mockApi } from './contract';
import { cspViolations, unexpected, watch } from './helpers';

test('gateway serves the build with its CSP and no inline script', async ({ page, context }) => {
  await mockApi(context, ANONYMOUS);
  const res = await page.goto('/login');
  expect(res?.status()).toBe(200);
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  const html = await res!.text();
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(await page.locator('script:not([src])').count()).toBe(0);
});

test('a CSP violation would be caught (the listener works)', async ({ page, context }) => {
  await mockApi(context, ANONYMOUS);
  await watch(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inline = 1';
    document.body.append(s);
  });
  await expect.poll(() => cspViolations(page)).toEqual([expect.stringMatching(/^script-src/)]);
  expect(await page.evaluate(() => (window as unknown as { __inline?: number }).__inline)).toBeUndefined();
});

test('the gateway without any backend: a transient failure, «Сервис недоступен» with a retry, not the login', async ({
  page,
}) => {
  await page.goto('/fields');
  await expect(page.getByRole('heading', { level: 1, name: 'Сервис недоступен' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/fields');
});

test('the public pages /p/* load no cabinet chunk and no mock code (module graph)', async ({
  page,
  context,
}) => {
  const w = await watch(page);
  const calls = await mockApi(context);
  const scripts = new Map<string, Promise<string>>();
  page.on('response', (r) => {
    if (r.request().resourceType() === 'script') scripts.set(new URL(r.url()).pathname, r.text());
  });
  expect(nodeCounts.app).toBeGreaterThan(30);
  expect(nodeCounts.public).toBe(3);
  expect(publicModules.some((m) => m.endsWith('src/lib/public/BatchView.svelte'))).toBe(true);
  expect(publicModules.filter((m) => CABINET_MODULE.test(m))).toEqual([]);
  expect(publicNotAllowed()).toEqual([]);
  expect(cabinetOnly.size).toBeGreaterThan(0);
  await page.goto('/p/AT-2026-000123');
  await expect(page.getByRole('heading', { level: 1, name: 'Пшеница озимая' })).toBeVisible();
  await expect(page.locator('.at-public__status')).toHaveAttribute('data-safety', 'SAFE');
  await page.goto('/p/AT-2026-000123/complaint');
  await expect(page.getByRole('heading', { level: 1, name: 'Сообщить о проблеме' })).toBeVisible();
  const loaded = [...scripts.keys()];
  expect(loaded.filter((f) => cabinetOnly.has(f))).toEqual([]);
  expect(calls.filter((c) => !c.startsWith('GET /api/v1/public/'))).toEqual([]);
  const bodies = await Promise.all(scripts.values());
  expect(bodies.filter((b) => b.includes('agrotrace-session') || b.includes('at-sidebar'))).toEqual([]);
  expect(publicModules.filter((m) => m.includes('packages/mock-api/'))).toEqual([]);
  expect(bodies.filter((b) => b.includes('mockServiceWorker') || b.includes('__agrotraceMock'))).toEqual([]);
  const workerType = await page.evaluate(async () =>
    (await fetch('/mockServiceWorker.js')).headers.get('content-type'),
  );
  expect(workerType).toContain('text/html');
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test('the public pages /p/* stay in the JS budget (60 KB gzip)', async ({ page, context }) => {
  await mockApi(context);
  const scripts = new Map<string, Promise<string>>();
  page.on('response', (r) => {
    if (r.request().resourceType() === 'script') scripts.set(new URL(r.url()).pathname, r.text());
  });
  await page.goto('/p/AT-2026-000123');
  await expect(page.getByRole('heading', { level: 1, name: 'Пшеница озимая' })).toBeVisible();
  const worker = page.waitForResponse((r) => /\/workers\/altcha\.worker-[^/]+\.js$/.test(r.url()));
  await page.goto('/p/AT-2026-000123/complaint');
  await expect(page.getByRole('heading', { level: 1, name: 'Сообщить о проблеме' })).toBeVisible();
  scripts.set(new URL((await worker).url()).pathname, (await worker).text());
  const bodies = await Promise.all(scripts.values());
  const gzip = bodies.reduce((sum, b) => sum + gzipSync(b).length, 0) / 1024;
  const note = `${scripts.size} scripts, ${gzip.toFixed(1)} KB gzip of 60 KB (headroom ${(60 - gzip).toFixed(1)} KB)`;
  test.info().annotations.push({ type: 'public JS', description: note });
  console.log(`public /p/* JS: ${note}`);
  expect(gzip).toBeLessThanOrEqual(60);
});

test('the /_ds showcase is not in the production build', async ({ page, context }) => {
  await mockApi(context, ANONYMOUS);
  await page.goto('/_ds');
  await expect(page.getByRole('heading', { level: 1, name: 'Страница не найдена' })).toBeVisible();
});
