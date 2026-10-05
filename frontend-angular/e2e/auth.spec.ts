import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './api';
import { PRODUCTION, signIn } from './helpers';

const h1 = (name: string) => `h1.at-page__title:text-is("${name}")`;
const CHALLENGE = 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f';
const historyLength = (page: Page) => page.evaluate(() => history.length);

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return {
    status,
    contentType: 'application/problem+json',
    body: { type: `/problems/${code.toLowerCase()}`, title: code, status, code, ...extra },
  };
}

async function signInForm(page: Page) {
  await page.getByLabel('Email').fill('inspector.head@agrotrace.test');
  await page.getByLabel('Пароль').fill('agrotrace-demo');
  await page.getByRole('button', { name: 'Войти' }).click();
}

test('/login/2fa without a challenge is the login (the entry replaced, `next` kept)', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator(h1('Вход'))).toBeVisible();
  const before = await historyLength(page);
  await page.goto('/login/2fa?next=%2Frecalls');
  await expect(page).toHaveURL(/\/login\?next=%2Frecalls$/);
  await expect(page.locator(h1('Вход'))).toBeVisible();
  expect(await historyLength(page)).toBe(before + 1);
});

test.describe('production build, crafted answers', () => {
  test.use(PRODUCTION);

  test('login → 2FA: the challenge survives a reload; a wrong code shows the attempts; the right one goes to `next`', async ({
    page,
  }) => {
    let wrong = true;
    await mockApi(page, {
      signedIn: false,
      overrides: {
        'POST /auth/login': {
          status: 200,
          contentType: 'application/json',
          body: { twoFactorRequired: true, challengeId: CHALLENGE },
        },
        'POST /auth/2fa/verify': () => {
          if (!wrong) return undefined;
          wrong = false;
          return problem(401, 'INVALID_TWO_FACTOR_CODE', { params: { attemptsLeft: 3 } });
        },
      },
    });
    await page.goto('/login?next=%2Frecalls');
    await signInForm(page);
    await expect(page).toHaveURL(/\/login\/2fa\?next=%2Frecalls$/);
    await expect(page.locator(h1('Код подтверждения'))).toBeFocused();
    await page.reload();
    await expect(page.locator(h1('Код подтверждения'))).toBeVisible();
    const code = page.getByLabel('Код из приложения');
    await code.fill('000000');
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(code).toHaveAccessibleDescription('Неверный код. Осталось попыток: 3');
    await expect(code).toBeFocused();
    let body: unknown;
    page.on('request', (r) => {
      if (r.url().endsWith('/auth/2fa/verify')) body = r.postDataJSON();
    });
    await code.fill('482915');
    await page.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page).toHaveURL(/\/403$/);
    await expect(page.locator(h1('Нет доступа'))).toBeFocused();
    expect(body).toEqual({ challengeId: CHALLENGE, code: '482915' });
  });

  test('429 on the login: «Повторить через N с», then «Войти» is back with the focus on it', async ({
    page,
  }) => {
    let limited = true;
    await mockApi(page, {
      signedIn: false,
      overrides: {
        'POST /auth/login': () => {
          if (!limited) return undefined;
          limited = false;
          return { ...problem(429, 'RATE_LIMITED'), headers: { 'Retry-After': '2' } };
        },
      },
    });
    await page.goto('/login');
    await signInForm(page);
    await expect(page.getByRole('button', { name: /^Повторить через \d с$/ })).toBeDisabled();
    await expect(page.locator('.at-toast-region[aria-live] .at-toast__text')).toHaveText(
      'Слишком много попыток — повторите через 2 с',
    );
    const login = page.getByRole('button', { name: 'Войти' });
    await expect(login).toBeEnabled({ timeout: 5000 });
    await expect(login).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator(h1('Панель'))).toBeVisible();
  });
});

test('invalid input: nothing is sent, the first invalid field gets the focus', async ({ page }) => {
  let sent = false;
  page.on('request', (r) => {
    if (r.url().endsWith('/auth/login')) sent = true;
  });
  await page.goto('/login');
  await page.getByLabel('Пароль').fill('x');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByLabel('Email')).toBeFocused();
  await expect(page.getByLabel('Email')).toHaveAccessibleDescription('Обязательное поле');
  expect(sent).toBe(false);
});

test.describe('production build, slow chunks', () => {
  test.use(PRODUCTION);

  test('while a slow page loads, a click on the current section cancels it and focuses its title', async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto('/batches');
    await expect(page.locator(h1('Партии'))).toBeVisible();
    const before = await historyLength(page);
    await page.route('**/assets/chunk-*.js', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    const sidebar = page.locator('.at-sidebar');
    await sidebar.getByRole('link', { name: 'Поля' }).click();
    await expect(page.locator('.at-shell__main > .at-page[aria-busy="true"]')).toBeVisible({ timeout: 1000 });
    await sidebar.getByRole('link', { name: 'Партии' }).click();
    await expect(page).toHaveURL(/\/batches$/);
    await expect(page.locator(h1('Партии'))).toBeFocused({ timeout: 1500 });
    await expect(sidebar.locator('a[href="/batches"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.at-shell__main > .at-page[aria-busy="true"]')).toHaveCount(0);
    await page.waitForTimeout(3000);
    await expect(page.locator(h1('Поля'))).toHaveCount(0);
    await expect(page).toHaveURL(/\/batches$/);
    expect(await historyLength(page)).toBeLessThanOrEqual(before + 2);
  });
});

test('profile and notifications render without console errors; the bell leads to the list', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await signIn(page, 'petrov@agrotrace.test', '/profile');
  await expect(page.locator(h1('Профиль'))).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Личные данные' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Email' })).toBeVisible();
  await page.locator('.at-bell').click();
  await expect(page.locator(h1('Уведомления'))).toBeFocused();
  await expect(page.getByRole('tab', { name: /Непрочитанные/ })).toBeVisible();
  await page.getByRole('tab', { name: /Непрочитанные/ }).click();
  await expect(page).toHaveURL(/\/notifications\?tab=unread$/);
  await expect(page.getByRole('tab', { name: /Непрочитанные/ })).toBeFocused();
  expect(errors).toEqual([]);
});
