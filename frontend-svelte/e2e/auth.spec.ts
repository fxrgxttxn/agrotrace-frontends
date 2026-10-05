import { expect, test, type Page } from '@playwright/test';
import { ANONYMOUS, contractExample, mockApi } from './contract';
import { cspViolations, unexpected, watch } from './helpers';

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const CHALLENGE = { twoFactorRequired: true, challengeId: 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f' };

async function toTwoFactor(page: Page) {
  await page.goto('/login?next=%2Fbatches');
  await page.getByLabel('Email').fill('inspector.head@agrotrace.test');
  await page.getByLabel('Пароль').fill('agrotrace-demo');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(h1(page, 'Код подтверждения')).toBeFocused();
}

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

test('429 on login: countdown, then «Войти» takes the focus back (only when it is free)', async ({
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
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('button', { name: /^Повторить через \d с$/ })).toBeDisabled();
  await page.getByLabel('Пароль').focus();
  await expect(page.getByRole('button', { name: 'Войти' })).toBeEnabled({ timeout: 4000 });
  await page.waitForTimeout(200);
  await expect(page.getByLabel('Пароль')).toBeFocused();
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
  await page.getByRole('checkbox', { name: 'Выбрать «Изъять партию AT-2026-000041»' }).locator('..').click();
  await page.getByRole('button', { name: 'Отметить прочитанным' }).click();
  await expect(h1(page, 'Уведомления')).toBeFocused();
  await expect(page.getByRole('link', { name: 'Уведомления, непрочитанных: 1' })).toBeVisible();
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test('Back after signing in through 2FA ends on the target page with its title focused (as React/Angular)', async ({
  page,
  context,
}) => {
  await mockApi(context, { ...ANONYMOUS, login: { body: CHALLENGE } });
  await page.goto('/password/forgot');
  await page.goto('/login?next=%2Fprofile');
  await page.getByLabel('Email').fill('inspector.head@agrotrace.test');
  await page.getByLabel('Пароль').fill('agrotrace-demo');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(h1(page, 'Код подтверждения')).toBeVisible();
  await page.getByLabel('Код из приложения').fill('482915');
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(h1(page, 'Профиль')).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(h1(page, 'Профиль')).toBeFocused();
  await page.goBack();
  await expect(h1(page, 'Восстановление пароля')).toBeVisible();
});

test('a typed /login/2fa (another entry) goes to /login even while a challenge is kept', async ({
  page,
  context,
}) => {
  await mockApi(context, { ...ANONYMOUS, login: { body: CHALLENGE } });
  await toTwoFactor(page);
  await page.goto('/password/forgot');
  await expect(h1(page, 'Восстановление пароля')).toBeVisible();
  await page.goto('/login/2fa?next=%2Fbatches');
  await expect(h1(page, 'Вход')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/login');
});

test('2FA start 429: the focus stays off the title during the wait, «Настроить» takes it back', async ({
  page,
  context,
}) => {
  const me = contractExample('getMe').body as Record<string, unknown>;
  await mockApi(context, {
    getMe: { body: { ...me, roles: ['ADMIN'] } },
    setupTwoFactor: { status: 429, headers: { 'Retry-After': '2' } },
  });
  await page.goto('/profile');
  const setup = page.getByRole('button', { name: 'Настроить' });
  await setup.click();
  await expect(page.getByRole('button', { name: /^Повторить через \d с$/ })).toBeDisabled();
  await page.waitForTimeout(500);
  await expect(h1(page, 'Профиль')).not.toBeFocused();
  await expect(setup).toBeFocused({ timeout: 4000 });
});
