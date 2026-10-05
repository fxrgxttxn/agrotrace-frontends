import { expect, test } from '@playwright/test';
import { mockApi } from './api';
import { PRODUCTION, signIn } from './helpers';

const h1 = (name: string) => `h1.at-page__title:text-is("${name}")`;
const focusedText = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? '');

test('first load leaves focus alone; a menu link focuses the new title; back / forward too', async ({
  page,
}) => {
  await signIn(page, 'petrov@agrotrace.test');
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
  await page.goto('/login?next=%2Fadmin%2Fusers');
  await expect(page.locator(h1('Вход'))).toBeVisible();
  await page.getByLabel('Email').fill('petrov@agrotrace.test');
  await page.getByLabel('Пароль').fill('agrotrace-demo');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/403$/);
  await expect(page.locator(h1('Нет доступа'))).toBeFocused();
  await page.goBack();
  await expect(page).not.toHaveURL(/\/403$/);
});

test('a start-up redirect is the first load: no focus move (/batches without a session → /login)', async ({
  page,
}) => {
  await page.goto('/batches');
  await expect(page.locator(h1('Вход'))).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('360 px: a pick in «Ещё» leaves the focus on «Ещё», the next navigation focuses the title again', async ({
  page,
}) => {
  await signIn(page, 'petrov@agrotrace.test');
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
  await signIn(page, 'petrov@agrotrace.test');
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

test.describe('production build, crafted answers and slow chunks', () => {
  test.use(PRODUCTION);

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

  test('the retry replaces its history entry: deep link + 503 + «Повторить» → /403 adds none', async ({
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
    const before = await page.evaluate(() => history.length);
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(page).toHaveURL(/\/403$/);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test('sign-in into a route of another role: /login → /admin/users → /403 replaces the entry (no extra history)', async ({
    page,
  }) => {
    await mockApi(page, { signedIn: false });
    await page.goto('/login?next=%2Fadmin%2Fusers');
    await expect(page.locator(h1('Вход'))).toBeVisible();
    const before = await page.evaluate(() => history.length);
    await page.getByLabel('Email').fill('petrov@agrotrace.test');
    await page.getByLabel('Пароль').fill('agrotrace-demo');
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page).toHaveURL(/\/403$/);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test('a lazy page (chunk delayed 2.5 s): URL and aria-current at once, the aria-busy loading page, then h1 focus', async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto('/batches');
    await expect(page.locator(h1('Партии'))).toBeVisible();
    await page.route('**/assets/chunk-*.js', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
    await expect(page).toHaveURL(/\/fields$/, { timeout: 1000 });
    await expect(page.locator('.at-sidebar a[href="/fields"]')).toHaveAttribute('aria-current', 'page', {
      timeout: 1000,
    });
    await expect(page.locator('.at-shell__main > .at-page[aria-busy="true"]')).toBeVisible({ timeout: 1000 });
    await expect(page.locator(h1('Партии'))).toBeHidden({ timeout: 1000 });
    await expect(page.locator(h1('Поля'))).toBeFocused({ timeout: 8000 });
    await expect(page.locator('.at-shell__main > .at-page[aria-busy="true"]')).toHaveCount(0);
    await expect(page.locator('.at-shell__main > .at-page')).toHaveCount(1);
  });
});
