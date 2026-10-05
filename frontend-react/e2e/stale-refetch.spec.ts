import { expect, test } from '@playwright/test';
import { stand } from './stand';

test('stale data whose refetch fails: the rows stay, the toast says «… не загрузились.»', async ({
  page,
}) => {
  await page.clock.install();
  await stand(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/notifications');
  const rows = page.locator('.at-table-wrap tbody tr');
  await expect(rows.first()).toBeVisible();
  const shown = await rows.count();
  await page.route(/\/api\/v1\/notifications(\?|$)/, (route) => route.abort());
  await page.clock.fastForward('00:31');
  await page.locator('.at-sidebar a[href="/profile"], .at-topbar a[href="/profile"]').first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Профиль' })).toBeVisible();
  await page.locator('a[href="/notifications"]').first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Уведомления' })).toBeVisible();
  await expect(rows).toHaveCount(shown);
  await page.clock.fastForward('00:05');
  await expect(page.locator('.at-toast-region[role="alert"]')).toContainText('Уведомления не загрузились.');
  await expect(rows).toHaveCount(shown);
  await expect(page.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
});

test('a refetch cancelled by another tab’s logout never toasts on /login', async ({ page }) => {
  await page.clock.install();
  await stand(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/notifications');
  await page.locator('.at-table-wrap tbody tr').first().waitFor();
  await page.route(/\/api\/v1\/notifications(\?|$)/, () => new Promise(() => {}));
  await page.clock.fastForward('00:31');
  await page.locator('a[href="/profile"]:visible').first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Профиль' })).toBeVisible();
  await page.locator('a[href="/notifications"]:visible').first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Уведомления' })).toBeVisible();
  const p2 = await page.context().newPage();
  await stand(p2);
  await p2.goto('/profile');
  await p2.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  await page.clock.fastForward('00:10');
  await page.waitForTimeout(300);
  await expect(page.locator('.at-toast')).not.toContainText(['Уведомления не загрузились.']);
});

test('another tab’s logout reaching /login never silences a wrong password', async ({ page }) => {
  await stand(page);
  const unauthorized = (code: string) => ({
    status: 401,
    contentType: 'application/problem+json',
    body: JSON.stringify({ type: '/problems/unauthorized', title: 'Unauthorized', status: 401, code }),
  });
  await page.route('**/api/v1/auth/refresh', (r) => r.fulfill(unauthorized('REFRESH_INVALID')));
  await page.route('**/api/v1/auth/login', (r) => r.fulfill(unauthorized('INVALID_CREDENTIALS')));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  const p2 = await page.context().newPage();
  await stand(p2);
  await p2.goto('/profile');
  await p2.getByRole('button', { name: 'Выйти' }).click();
  await expect(p2.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  await p2.close();
  await page.getByLabel('Email').fill('a@x.ru');
  await page.getByLabel('Пароль').fill('wrong-password');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.locator('.at-toast-region[role="alert"]')).toContainText('Неверный email или пароль');
});
