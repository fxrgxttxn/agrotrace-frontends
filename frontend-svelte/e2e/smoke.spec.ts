import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { cabinetOnly, CABINET_MODULE, nodeCounts, publicModules } from './chunks';
import { ANONYMOUS, mockApi } from './contract';
import { cspViolations, horizontalOverflow, unexpected, watch } from './helpers';

// Smoke check of the Svelte build behind its gateway (the real CSP `script-src 'self'`, the real SvelteKit router):
// the login screen renders with no console error and no CSP violation, 360 px has no horizontal scroll, guards and
// focus behave as in the React app, the public QR pages load no cabinet code, and the shell is photographed at
// 360 / 900 / 1280 in both themes. API answers: the contract's examples (e2e/contract.ts).

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

test('/login renders without console errors or CSP violations, no horizontal scroll at 360 px', async ({
  page,
  context,
}) => {
  await mockApi(context, ANONYMOUS);
  const w = await watch(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Пароль')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // the sprite is in the document and the design system CSS applies
  expect(await page.locator('body > svg#at-sprite symbol#i-bell').count()).toBe(1);
  expect(await page.locator('.at-toasts > .at-toast-region').count()).toBe(2);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `test-results/shots/login-360-${scheme}.png`, fullPage: true });
  }
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

test('a cabinet route without a session goes to /login?next=', async ({ page, context }) => {
  await mockApi(context, ANONYMOUS);
  await page.goto('/batches?status=Approved');
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(new URL(page.url()).searchParams.get('next')).toBe('/batches?status=Approved');
});

test('the gateway without any backend: a transient failure, «Сервис недоступен» with a retry, not the login', async ({
  page,
}) => {
  await page.goto('/fields');
  await expect(page.getByRole('heading', { level: 1, name: 'Сервис недоступен' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/fields');
});

test('signed in: the shell, the role guard, route focus and logout (real SvelteKit router)', async ({
  page,
  context,
}) => {
  const w = await watch(page);
  await mockApi(context);
  await page.goto('/batches');
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
  await expect(page.locator('.at-topbar__org-name')).toHaveText('КФХ Петров');
  await expect(page.locator('a.at-bell')).toHaveAttribute('aria-label', 'Уведомления, непрочитанных: 3');
  // first load: focus not moved
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Поля' })).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeFocused();
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { level: 1, name: 'Нет доступа' })).toBeVisible();
  await expect(page).toHaveURL(/\/403$/);
  await page.goto('/no/such/page');
  await expect(page.getByRole('heading', { level: 1, name: 'Страница не найдена' })).toBeVisible();
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
});

test('logout in one tab ends the session in the other', async ({ context }) => {
  await mockApi(context);
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto('/batches');
  await b.goto('/fields');
  await expect(b.getByRole('heading', { level: 1, name: 'Поля' })).toBeVisible();
  await a.goto('/profile');
  await a.getByRole('button', { name: 'Выйти' }).click();
  await expect(b.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  expect(new URL(b.url()).pathname).toBe('/login');
});

test('the public pages /p/* load no cabinet chunk (module graph) and stay in the JS budget', async ({
  page,
  context,
}) => {
  const w = await watch(page);
  const calls = await mockApi(context);
  const scripts = new Map<string, Promise<string>>();
  page.on('response', (r) => {
    if (r.request().resourceType() === 'script') scripts.set(new URL(r.url()).pathname, r.text());
  });
  // The module graph of the public pages (their nodes, the root layout, the kit entries and all static imports): no
  // cabinet module at all — session, live stream, guards, forms, shell, cabinet pages, (app) routes.
  expect(nodeCounts.app).toBeGreaterThan(30);
  expect(nodeCounts.public).toBe(3); // the three /p pages (the group has no layout of its own)
  expect(publicModules.some((m) => m.endsWith('src/lib/public/PublicPage.svelte'))).toBe(true);
  expect(publicModules.filter((m) => CABINET_MODULE.test(m))).toEqual([]);
  expect(cabinetOnly.size).toBeGreaterThan(0);
  await page.goto('/p/AT-2026-000123');
  await expect(page.getByRole('heading', { level: 1, name: 'Партия' })).toBeVisible();
  await expect(page.locator('p.at-mono')).toHaveText('AT-2026-000123');
  await page.goto('/p/AT-2026-000123/complaint');
  await expect(page.getByRole('heading', { level: 1, name: 'Сообщить о проблеме' })).toBeVisible();
  const loaded = [...scripts.keys()];
  expect(loaded.filter((f) => cabinetOnly.has(f))).toEqual([]);
  // no session restore, no stream: nothing of the cabinet ran
  expect(calls).toEqual([]);
  const bodies = await Promise.all(scripts.values());
  expect(bodies.filter((b) => b.includes('agrotrace-session') || b.includes('at-sidebar'))).toEqual([]);
  const gzip = bodies.reduce((sum, b) => sum + gzipSync(b).length, 0) / 1024;
  const note = `${loaded.length} scripts, ${gzip.toFixed(1)} KB gzip of 60 KB (headroom ${(60 - gzip).toFixed(1)} KB)`;
  test.info().annotations.push({ type: 'public JS', description: note });
  console.log(`public /p/* JS: ${note}`);
  expect(gzip).toBeLessThanOrEqual(60);
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test('shell screenshots at 360 / 900 / 1280 in both themes and the «Ещё» sheet', async ({
  page,
  context,
}) => {
  await mockApi(context);
  for (const width of [360, 900, 1280])
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width === 360 ? 780 : 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/batches');
      await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await horizontalOverflow(page), `${width} ${scheme}`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/shots/shell-${width}-${scheme}.png` });
      if (width === 360) {
        await page.getByRole('button', { name: 'Ещё' }).click();
        await expect(page.locator('#more-menu')).toBeVisible();
        await expect(page.locator('#more-title')).toBeFocused();
        await page.waitForTimeout(400); // the sheet's opening transition
        await page.screenshot({ path: `test-results/shots/more-${scheme}.png` });
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Ещё' })).toBeFocused();
      }
    }
});

test('the /_ds showcase is not in the production build', async ({ page, context }) => {
  await mockApi(context, ANONYMOUS);
  await page.goto('/_ds');
  await expect(page.getByRole('heading', { level: 1, name: 'Страница не найдена' })).toBeVisible();
});
