import { expect, test, type Page } from '@playwright/test';
import { cspViolations, DEMO_PASSWORD, horizontalOverflow, signIn, unexpected, watch } from './helpers';

const DEMO = { email: 'petrov@agrotrace.test', password: DEMO_PASSWORD, org: 'КФХ Петров И.С.' };
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

test('the mock build: CSP, no inline script, the worker served uncached and controlling the page', async ({
  page,
}) => {
  const w = await watch(page);
  const res = await page.goto('/login');
  expect(res?.status()).toBe(200);
  expect(res?.headers()['content-security-policy'] ?? '').toContain("script-src 'self'");
  expect(await res!.text()).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  await expect(h1(page, 'Вход')).toBeVisible();
  expect(await page.locator('script:not([src])').count()).toBe(0);
  const worker = await page.evaluate(async () => {
    const r = await fetch('/mockServiceWorker.js', { cache: 'no-store' });
    return { status: r.status, cache: r.headers.get('cache-control'), type: r.headers.get('content-type') };
  });
  expect(worker).toEqual({ status: 200, cache: 'no-cache', type: 'application/javascript' });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  expect(await page.evaluate(() => '__agrotraceMock' in window)).toBe(true);
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test('/login renders without console errors or CSP violations, no horizontal scroll at 360 px', async ({
  page,
}) => {
  const w = await watch(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/login');
  await expect(h1(page, 'Вход')).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Пароль')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
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

test('a cabinet route without a session goes to /login?next=', async ({ page }) => {
  await page.goto('/batches?status=Approved');
  await expect(h1(page, 'Вход')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(new URL(page.url()).searchParams.get('next')).toBe('/batches?status=Approved');
});

test('a demo user signs in, sees the shell, meets the role guard, keeps the session on reload, logs out', async ({
  page,
}) => {
  const w = await watch(page);
  await page.goto('/login?next=%2Fbatches');
  await signIn(page, DEMO.email, DEMO.password, w);
  await expect(h1(page, 'Партии')).toBeFocused();
  await expect(page).toHaveURL(/\/batches$/);
  await expect(page.locator('.at-topbar__org-name')).toHaveText(DEMO.org);
  await expect(page.locator('a.at-bell')).toHaveAttribute('aria-label', /^Уведомления/);
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(h1(page, 'Поля')).toBeFocused();
  await page.goBack();
  await expect(h1(page, 'Партии')).toBeFocused();

  await page.goto('/admin/users');
  await expect(h1(page, 'Нет доступа')).toBeVisible();
  await expect(page).toHaveURL(/\/403$/);

  await page.goto('/fields');
  await expect(h1(page, 'Поля')).toBeVisible();
  await page.reload();
  await expect(h1(page, 'Поля')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
  await expect(page.locator('.at-topbar__org-name')).toHaveText(DEMO.org);
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(h1(page, 'Вход')).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
});

test('logout in one tab ends the session in the other', async ({ context }) => {
  const a = await context.newPage();
  await signIn(a, DEMO.email, DEMO.password);
  await expect(h1(a, 'Панель')).toBeVisible();
  const b = await context.newPage();
  await b.goto('/fields');
  await expect(h1(b, 'Поля')).toBeVisible();
  await a.goto('/profile');
  await a.getByRole('button', { name: 'Выйти' }).click();
  await expect(h1(b, 'Вход')).toBeVisible();
  expect(new URL(b.url()).pathname).toBe('/login');
});

test('the public page /p/:code on the mock: the batch, no cabinet code ran', async ({ page }) => {
  const w = await watch(page);
  const code = `AT-${new Date().getFullYear()}-000002`;
  const calls: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/v1/')) calls.push(path);
  });
  await page.goto(`/p/${code}`);
  await expect(h1(page, 'Молоко пастеризованное 3,2%')).toBeVisible();
  await expect(page.locator('.at-card__facts .at-mono')).toHaveText(code);
  expect(calls.filter((c) => c.startsWith('/api/v1/auth') || c.startsWith('/api/v1/events'))).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test('/login/2fa without a challenge goes to /login, replacing the entry', async ({ page }) => {
  await page.goto('/login');
  await expect(h1(page, 'Вход')).toBeVisible();
  const length = await page.evaluate(() => history.length);
  await page.goto('/login/2fa?next=%2Ffields');
  await expect(h1(page, 'Вход')).toBeVisible();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/login?next=%2Ffields');
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
});

test('a client-side refusal focuses the first invalid field and sends nothing', async ({ page }) => {
  const logins: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/v1/auth/login') logins.push(r.method());
  });
  await page.goto('/login');
  await page.getByLabel('Пароль').fill('x');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByLabel('Email')).toBeFocused();
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
  expect(logins).toEqual([]);
});

test('profile and notifications at 360 px: no console errors, no CSP violations, no horizontal scroll', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, DEMO.email, DEMO.password, w);
  await expect(h1(page, 'Панель')).toBeVisible();
  await page.setViewportSize({ width: 360, height: 780 });
  for (const [path, title] of [
    ['/profile', 'Профиль'],
    ['/notifications', 'Уведомления'],
  ] as const) {
    await page.goto(path);
    await expect(h1(page, title)).toBeVisible();
    await page.waitForTimeout(300);
    expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
  }
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test('shell screenshots at 360 / 900 / 1280 in both themes and the «Ещё» sheet', async ({ page }) => {
  await signIn(page, DEMO.email, DEMO.password);
  await expect(h1(page, 'Панель')).toBeVisible();
  for (const width of [360, 900, 1280])
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width === 360 ? 780 : 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/batches');
      await expect(h1(page, 'Партии')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await horizontalOverflow(page), `${width} ${scheme}`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/shots/shell-${width}-${scheme}.png` });
      if (width === 360) {
        await page.getByRole('button', { name: 'Ещё' }).click();
        await expect(page.locator('#more-menu')).toBeVisible();
        await expect(page.locator('#more-title')).toBeFocused();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `test-results/shots/more-${scheme}.png` });
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Ещё' })).toBeFocused();
      }
    }
});

test('the /_ds showcase is not in the mock build either', async ({ page }) => {
  await page.goto('/_ds');
  await expect(h1(page, 'Страница не найдена')).toBeVisible();
});
