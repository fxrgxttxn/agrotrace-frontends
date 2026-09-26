import { expect, test } from '@playwright/test';
import { stand } from './stand';

// FM24 on the built app (contract-example stand): data older than 30 s is shown while it is asked again; if that
// refetch fails (after its retries), the rows stay and a toast says what did not load — no empty screen, no dead end.

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
  // The list gets older than its 30 s freshness; from now on it cannot be read.
  await page.route(/\/api\/v1\/notifications(\?|$)/, (route) => route.abort());
  await page.clock.fastForward('00:31');
  await page.locator('.at-sidebar a[href="/profile"], .at-topbar a[href="/profile"]').first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Профиль' })).toBeVisible();
  await page.locator('a[href="/notifications"]').first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Уведомления' })).toBeVisible();
  // The cached rows at once, then two retries (≈ 1 s, 2 s) and the failure.
  await expect(rows).toHaveCount(shown);
  await page.clock.fastForward('00:05');
  await expect(page.locator('.at-toast-region[role="alert"]')).toContainText('Уведомления не загрузились.');
  await expect(rows).toHaveCount(shown);
  await expect(page.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
});
