import { expect, test, type Page } from '@playwright/test';
import { ANONYMOUS, mockApi } from './contract';
import { cspViolations, horizontalOverflow, unexpected, watch } from './helpers';

// S2 screens with the REAL SvelteKit router of the build (ruling FM7: focus and history are verified here): the 2FA
// step and its history state, the 429 wait and FM17, form focus, the tabs / pagination of the notifications (query-only
// navigation keeps the focus), FM21 focus after an action, no console errors or CSP violations.

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const CHALLENGE = { twoFactorRequired: true, challengeId: 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f' };

async function toTwoFactor(page: Page) {
  await page.goto('/login?next=%2Fbatches');
  await page.getByLabel('Email').fill('inspector.head@agrotrace.test');
  await page.getByLabel('Пароль').fill('agrotrace-demo');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(h1(page, 'Код подтверждения')).toBeFocused();
}

test('/login/2fa without a challenge goes to /login, replacing the entry', async ({ page, context }) => {
  await mockApi(context, ANONYMOUS);
  await page.goto('/login');
  await expect(h1(page, 'Вход')).toBeVisible();
  const length = await page.evaluate(() => history.length);
  await page.goto('/login/2fa?next=%2Ffields');
  await expect(h1(page, 'Вход')).toBeVisible();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/login?next=%2Ffields');
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
});

test('the 2FA challenge survives a reload; the code signs in and `next` gets the focus', async ({
  page,
  context,
}) => {
  await mockApi(context, { ...ANONYMOUS, login: { body: CHALLENGE } });
  await toTwoFactor(page);
  await page.reload();
  await expect(h1(page, 'Код подтверждения')).toBeVisible();
  await context.unroute('**/api/v1/**');
  await mockApi(context, { refreshToken: { status: 401, once: true } });
  await page.getByLabel('Код из приложения').fill('482915');
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(h1(page, 'Партии')).toBeFocused();
  expect(new URL(page.url()).pathname).toBe('/batches');
});

test('429 on login: countdown, then «Войти» takes the focus back (FM17: only when it is free)', async ({
  page,
  context,
}) => {
  await mockApi(context, { ...ANONYMOUS, login: { status: 429, headers: { 'Retry-After': '2' } } });
  await page.goto('/login');
  await page.getByLabel('Email').fill('petrov@kfh-petrov.ru');
  await page.getByLabel('Пароль').fill('agrotrace-demo');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('button', { name: /^Повторить через \d с$/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Войти' })).toBeFocused({ timeout: 4000 });
  // again, and this time the person moves to a field during the wait: the field keeps the focus
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('button', { name: /^Повторить через \d с$/ })).toBeDisabled();
  await page.getByLabel('Пароль').focus();
  await expect(page.getByRole('button', { name: 'Войти' })).toBeEnabled({ timeout: 4000 });
  await page.waitForTimeout(200);
  await expect(page.getByLabel('Пароль')).toBeFocused();
});

test('a client-side refusal focuses the first invalid field and sends nothing', async ({ page, context }) => {
  const calls = await mockApi(context, ANONYMOUS);
  await page.goto('/login');
  await page.getByLabel('Пароль').fill('x');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByLabel('Email')).toBeFocused();
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
  expect(calls.filter((c) => c.includes('/auth/login'))).toEqual([]);
});

test('notifications: a tab and a page link keep the focus (query-only); marking read focuses the title', async ({
  page,
  context,
}) => {
  const w = await watch(page);
  const note = (seq: number) => ({
    id: `b7c8d9e0-f1a2-4b3c-8d4e-${seq.toString(16).padStart(12, '0')}`,
    seq,
    type: 'RECALL_TASK',
    payload: {
      recallId: '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d',
      taskId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
      batchId: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f',
      publicCode: `AT-2026-${String(seq).padStart(6, '0')}`,
      dueAt: '2026-09-25T15:00:00Z',
      event: 'CREATED',
    },
    isRead: false,
    createdAt: '2026-09-24T09:00:12Z',
  });
  await mockApi(context, {
    listNotifications: { body: { items: [note(42), note(41)], page: 1, size: 20, total: 45 } },
    markNotificationsRead: { body: { count: 1 } },
  });
  await page.goto('/notifications');
  await expect(page.getByRole('link', { name: 'Изъять партию AT-2026-000042' })).toBeVisible();
  const unread = page.getByRole('tab', { name: /Непрочитанные/ });
  await unread.click();
  await expect(page).toHaveURL(/\?tab=unread$/);
  await expect(unread).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('tab', { name: 'Все' })).toBeFocused();
  const two = page.locator('.at-pagination').getByRole('link', { name: '2' });
  await two.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\?page=2$/);
  await expect(page.locator('.at-pagination a[aria-current="page"]')).toHaveText('2');
  // the box itself is visually hidden under its label (README «Флажок»): the person clicks the label
  await page.getByRole('checkbox', { name: 'Выбрать «Изъять партию AT-2026-000041»' }).locator('..').click();
  await page.getByRole('button', { name: 'Отметить прочитанным' }).click();
  await expect(h1(page, 'Уведомления')).toBeFocused();
  await expect(page.getByRole('link', { name: 'Уведомления, непрочитанных: 1' })).toBeVisible();
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test('profile and notifications at 360 px: no console errors, no CSP violations, no horizontal scroll', async ({
  page,
  context,
}) => {
  const w = await watch(page);
  await mockApi(context);
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
