import { expect, test } from '@playwright/test';
import { stand } from './stand';

test('a route of another role: the redirect to /403 focuses its title', async ({ page }) => {
  await stand(page);
  await page.goto('/batches');
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
  await page.locator('.at-sidebar a[href="/fields"]').focus();
  await page.evaluate(() => {
    window.history.pushState({}, '', '/recalls');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  const title = page.getByRole('heading', { level: 1, name: 'Нет доступа' });
  await expect(title).toBeVisible();
  await expect(title).toBeFocused();
});

const go = (page: import('@playwright/test').Page, path: string) =>
  page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);

test('a redirect back to the same pathname focuses the new page title: /login → «/», /403 → /403', async ({
  page,
}) => {
  await stand(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Панель' })).toBeVisible();
  await page.locator('.at-sidebar a[href="/batches"]').focus();
  await go(page, '/login');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Панель' })).toBeFocused();

  await go(page, '/recalls');
  const forbidden = page.getByRole('heading', { level: 1, name: 'Нет доступа' });
  await expect(forbidden).toBeFocused();
  await page.locator('.at-sidebar a[href="/batches"]').focus();
  await go(page, '/complaints');
  await expect(page).toHaveURL(/\/403$/);
  await expect(forbidden).toBeFocused();
});
