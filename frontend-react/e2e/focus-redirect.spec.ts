import { expect, test } from '@playwright/test';
import { stand } from './stand';

// FM7 (ruling F4): a client-side navigation that ends in a redirect to another pathname (a route of another role →
// /403) moves the focus to the new page's title, in the built app in a real browser (contract-example stand).

test('a route of another role: the redirect to /403 focuses its title', async ({ page }) => {
  await stand(page);
  await page.goto('/batches');
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
  await page.locator('.at-sidebar a[href="/fields"]').focus();
  // A client-side navigation (as the router's own links do) to /recalls — INSPECTOR only.
  await page.evaluate(() => {
    window.history.pushState({}, '', '/recalls');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  const title = page.getByRole('heading', { level: 1, name: 'Нет доступа' });
  await expect(title).toBeVisible();
  await expect(title).toBeFocused();
});
