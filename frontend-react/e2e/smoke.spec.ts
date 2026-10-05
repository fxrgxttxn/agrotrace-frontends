import { expect, test } from '@playwright/test';
import { cspViolations, DEMO_PASSWORD, horizontalOverflow, signIn, unexpected, watch } from './helpers';

const DEMO = { email: 'petrov@agrotrace.test', password: DEMO_PASSWORD, org: 'КФХ Петров И.С.' };

test('gateway serves the build with its CSP', async ({ page }) => {
  const res = await page.goto('/login');
  expect(res?.status()).toBe(200);
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(await page.locator('script:not([src])').count()).toBe(0);
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
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
  await page.screenshot({ path: 'test-results/shots/login-360-light.png', fullPage: true });
});

test('a cabinet route without a session goes to /login?next=', async ({ page }) => {
  await page.goto('/batches?status=Approved');
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('next')).toBe('/batches?status=Approved');
});

test('the public entry renders /p/:publicCode without cabinet code', async ({ page }) => {
  const w = await watch(page);
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname);
  });
  await page.goto('/p/AT-2026-000002');
  await expect(page.getByRole('heading', { level: 1, name: 'Молоко пастеризованное 3,2%' })).toBeVisible();
  expect(scripts.some((s) => /\/assets\/(auth|home|fields|batches|admin)-/.test(s))).toBe(false);
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test('a demo user signs in, sees the shell, meets the role guard and keeps the session on reload', async ({
  page,
}) => {
  const w = await watch(page);
  await page.goto('/login?next=%2Fbatches');
  await signIn(page, DEMO.email, DEMO.password, w);
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
  await expect(page).toHaveURL(/\/batches$/);
  await expect(page.locator('.at-topbar__org-name')).toHaveText(DEMO.org);
  await expect(page.locator('.at-sidebar').getByRole('link', { name: 'Поля' })).toBeVisible();

  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { level: 1, name: 'Нет доступа' })).toBeVisible();
  await expect(page).toHaveURL(/\/403$/);

  await page.goto('/fields');
  await expect(page.getByRole('heading', { level: 1, name: 'Поля' })).toBeVisible();
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
});

test('shell screenshots at 360 / 900 / 1280 in both themes (for comparison with the showcase)', async ({
  page,
}) => {
  await page.goto('/login');
  await signIn(page, DEMO.email, DEMO.password);
  await expect(page.getByRole('heading', { level: 1, name: 'Панель' })).toBeVisible();
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

test('the /_ds showcase is not in the production build', async ({ page }) => {
  await page.goto('/_ds');
  await expect(page.getByRole('heading', { level: 1, name: 'Страница не найдена' })).toBeVisible();
});
