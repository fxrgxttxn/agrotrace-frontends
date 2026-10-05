import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { cspViolations, horizontalOverflow, PRODUCTION, signIn, unexpected, watch } from './helpers';

async function angularMarkers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('body, body *')) {
      if (el.tagName === 'ROUTER-OUTLET') out.push('<router-outlet>');
      for (const a of el.attributes)
        if (/^(ng-reflect-|_ngcontent|_nghost|ng-version$)/.test(a.name)) out.push(a.name);
    }
    return out;
  });
}

async function servesTheBuild(page: Page): Promise<number> {
  const res = await page.goto('/login');
  expect(res?.status()).toBe(200);
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  const html = await res!.text();
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(html).not.toMatch(/\son[a-z]+=/i);
  expect(html).not.toMatch(/<base\s/i);
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
  expect(refs.length).toBeGreaterThan(1);
  for (const ref of refs) expect(ref).toMatch(/^\/assets\//);
  const probe = await page.evaluate(async (ref) => {
    const asset = await fetch(ref);
    const missing = await fetch('/assets/chunk-MISSING.js');
    const worker = await fetch('/mockServiceWorker.js');
    const js = (worker.headers.get('content-type') ?? '').includes('javascript');
    return {
      cache: asset.headers.get('cache-control') ?? '',
      missing: missing.status,
      worker: js ? worker.status : 0,
    };
  }, refs[0]!);
  expect(probe.cache).toContain('immutable');
  expect(probe.missing).toBe(404);
  return probe.worker;
}

test('the mock build: its CSP, only external scripts, no inline handlers, the MSW worker at the root', async ({
  page,
}) => {
  expect(await servesTheBuild(page)).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  const answer = await page.evaluate(async () => {
    const r = await fetch('/api/v1/public/regions');
    return { status: r.status, type: r.headers.get('content-type') ?? '' };
  });
  expect(answer.status).toBe(200);
  expect(answer.type).toContain('application/json');
});

test('/login renders without console errors or CSP violations, no horizontal scroll at 360 px', async ({
  page,
}) => {
  const w = await watch(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Пароль')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.locator('body > svg#at-sprite symbol#i-bell').count()).toBe(1);
  expect(await page.locator('main.at-page svg.at-empty__art path').count()).toBeGreaterThan(3);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await cspViolations(page)).toEqual([]);
  expect(await angularMarkers(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
  await page.screenshot({ path: 'test-results/shots/login-360-light.png', fullPage: true });
});

test('a cabinet route without a session goes to /login?next=', async ({ page }) => {
  await page.goto('/batches?status=Approved');
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('next')).toBe('/batches?status=Approved');
});

test('signed in: the shell, the role guard (403), logout — no console errors, no markers', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'petrov@agrotrace.test', '/batches');
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
  await expect(page.locator('.at-topbar__org-name')).toHaveText('КФХ Петров И.С.');
  await expect(page.locator('.at-sidebar').getByRole('link', { name: 'Поля' })).toBeVisible();
  expect(await page.locator('.at-shell__main > .at-page').count()).toBe(1);
  expect(await angularMarkers(page)).toEqual([]);

  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Поля' })).toBeFocused();

  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { level: 1, name: 'Нет доступа' })).toBeVisible();
  await expect(page).toHaveURL(/\/403$/);

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test('shell screenshots at 360 / 900 / 1280 in both themes (for comparison with React and the showcase)', async ({
  page,
}) => {
  await signIn(page, 'petrov@agrotrace.test', '/batches');
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
        await page.waitForTimeout(400);
        await page.screenshot({ path: `test-results/shots/more-${scheme}.png` });
        await page.keyboard.press('Escape');
      }
    }
});

test.describe('the production build (no mock)', () => {
  test.use(PRODUCTION);

  test('the stand serves it with its CSP, only external scripts, no inline handlers, no MSW worker', async ({
    page,
  }) => {
    expect(await servesTheBuild(page)).toBe(0);
  });

  test('no API at all: a cabinet route shows «Сервис недоступен», never a logout', async ({ page }) => {
    const w = await watch(page);
    await page.goto('/batches');
    await expect(page.getByRole('heading', { level: 1, name: 'Сервис недоступен' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/batches');
    await expect(page.getByRole('button', { name: 'Повторить' })).toBeEnabled();
    expect(await cspViolations(page)).toEqual([]);
    expect(unexpected(w, [/^http 502 POST \/api\/v1\/auth\/refresh$/])).toEqual([]);
  });

  test('the public entry renders /p/:publicCode without cabinet code (size noted)', async ({ page }) => {
    const w = await watch(page);
    const scripts: { url: string; body: Buffer }[] = [];
    page.on('response', async (r) => {
      if (r.request().resourceType() === 'script') scripts.push({ url: r.url(), body: await r.body() });
    });
    await page.goto('/p/AT-2026-000123');
    await expect(page.getByRole('heading', { level: 1, name: 'Партия' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const js = scripts.map((s) => s.body.toString('utf8')).join('\n');
    expect(js).not.toContain('agrotrace-session');
    expect(js).not.toContain('NG04002');
    expect(js).not.toContain('Zone.__symbol__');
    expect(js).not.toContain('mockServiceWorker');
    const gzip = scripts.reduce((sum, s) => sum + gzipSync(s.body).length, 0);
    test.info().annotations.push({
      type: 'public JS gzip',
      description: `${(gzip / 1024).toFixed(1)} KB in ${scripts.length} files`,
    });
    console.log(`public entry JS: ${(gzip / 1024).toFixed(1)} KB gzip in ${scripts.length} files`);
    expect(await cspViolations(page)).toEqual([]);
    expect(unexpected(w, [/^http 502 GET \/api\/v1\/public\//])).toEqual([]);
  });

  test('the /_ds showcase is not in the production build', async ({ page }) => {
    await page.goto('/_ds');
    await expect(page.getByRole('heading', { level: 1, name: 'Страница не найдена' })).toBeVisible();
  });
});
