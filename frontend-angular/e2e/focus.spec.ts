import { expect, test } from '@playwright/test';
import { mockApi } from './api';

// Focus and history against the real Angular router in a real browser (ruling FM7; design-system README «Фокус при
// смене маршрута», F4): a client-side pathname change focuses the new page's h1 — redirects that change the pathname
// included — except the first load; «Ещё» keeps its own rule; back / forward behave the same.

const h1 = (name: string) => `h1.at-page__title:text-is("${name}")`;
const focusedText = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? '');

test('first load leaves focus alone; a menu link focuses the new title; back / forward too', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/batches');
  await expect(page.locator(h1('Партии'))).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

  await page.locator('.at-sidebar').getByRole('link', { name: 'Накладные' }).click();
  await expect(page.locator(h1('Накладные'))).toBeFocused();
  await expect(page).toHaveURL(/\/waybills$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/batches$/);
  await expect(page.locator(h1('Партии'))).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(/\/waybills$/);
  await expect(page.locator(h1('Накладные'))).toBeFocused();
});

test('a redirect that changes the pathname focuses the page title (sign-in → next of another role → /403)', async ({
  page,
}) => {
  await mockApi(page, { signedIn: false });
  await page.goto('/login?next=%2Fadmin%2Fusers');
  await expect(page.locator(h1('Вход'))).toBeVisible();
  await page.getByLabel('Email').fill('petrov@agrotrace.test');
  await page.getByLabel('Пароль').fill('agrotrace-demo');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/403$/);
  await expect(page.locator(h1('Нет доступа'))).toBeFocused();
  // history: the login entry was replaced (as React's `replace`), back leaves the app's cabinet
  await page.goBack();
  await expect(page).not.toHaveURL(/\/403$/);
});

test('a start-up redirect is the first load: no focus move (/batches without a session → /login)', async ({
  page,
}) => {
  await mockApi(page, { signedIn: false });
  await page.goto('/batches');
  await expect(page.locator(h1('Вход'))).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('360 px: a pick in «Ещё» leaves the focus on «Ещё», the next navigation focuses the title again', async ({
  page,
}) => {
  await mockApi(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/batches');
  await expect(page.locator(h1('Партии'))).toBeVisible();
  const more = page.getByRole('button', { name: 'Ещё' });
  await more.click();
  await expect(page.locator('#more-menu')).toBeVisible();
  await expect(page.locator('#more-title')).toBeFocused();
  await page.locator('#more-menu').getByRole('link', { name: 'Профиль' }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.locator(h1('Профиль'))).toBeVisible();
  await expect(page.locator('#more-menu')).toBeHidden();
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  await page.locator('.at-bottom-nav').getByRole('link', { name: 'Поля' }).click();
  await expect(page.locator(h1('Поля'))).toBeFocused();
});

test('keyboard: Esc closes «Ещё» and the focus returns to it', async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/batches');
  const more = page.getByRole('button', { name: 'Ещё' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#more-title')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#more-menu')).toBeHidden();
  await expect(more).toBeFocused();
});

test('after «Повторить» succeeds the role guard runs: a FARMER deep link to /admin/users ends on /403', async ({
  page,
}) => {
  let first = true;
  await mockApi(page, {
    overrides: {
      'POST /auth/refresh': () => {
        if (!first) return undefined;
        first = false;
        return { status: 503 };
      },
    },
  });
  await page.goto('/admin/users');
  await expect(page.locator(h1('Сервис недоступен'))).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page).toHaveURL(/\/403$/);
  await expect(page.locator(h1('Нет доступа'))).toBeVisible();
  // a redirect to a new pathname (F4 / FM7)
  await expect(page.locator(h1('Нет доступа'))).toBeFocused();
});

test('429 at start-up: the retry waits Retry-After, then the focus is on «Повторить»', async ({ page }) => {
  let limited = true;
  await mockApi(page, {
    overrides: {
      'GET /me': () => {
        if (!limited) return undefined;
        limited = false;
        return {
          status: 429,
          contentType: 'application/problem+json',
          headers: { 'Retry-After': '2' },
          body: {
            type: '/problems/rate-limited',
            title: 'Too many requests',
            status: 429,
            code: 'RATE_LIMITED',
          },
        };
      },
    },
  });
  await page.goto('/fields');
  await expect(page.locator(h1('Сервис недоступен'))).toBeVisible();
  await expect(page.getByRole('button', { name: /^Повторить через \d+ с$/ })).toBeDisabled();
  const retry = page.getByRole('button', { name: 'Повторить', exact: true });
  await expect(retry).toBeEnabled({ timeout: 5000 });
  await expect(retry).toBeFocused();
  expect(await focusedText(page)).toBe('Повторить');
  await page.keyboard.press('Enter');
  await expect(page.locator(h1('Поля'))).toBeVisible();
  await expect(page).toHaveURL(/\/fields$/);
});
