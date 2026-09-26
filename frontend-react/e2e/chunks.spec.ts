import { expect, test } from '@playwright/test';
import { stand } from './stand';

// FM10/FM11 on the built app (contract-example stand): a lazy page shows the loading page and the new aria-current at
// once while its chunk loads, then its title gets the focus; a chunk that fails to load makes one full load of the
// target URL and then a plain «Не удалось загрузить страницу» with «Повторить» inside the shell — never a raw error.

test('a slow page chunk: the loading page and aria-current at once, then the title is focused', async ({
  page,
}) => {
  await stand(page);
  await page.goto('/batches');
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route(/\/assets\/waybills-[^/]+\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  const link = page.locator('.at-sidebar a[href="/waybills"]');
  await link.click();
  await expect(page.locator('main [aria-busy="true"]')).toBeVisible();
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toHaveCount(0);
  release();
  const title = page.getByRole('heading', { level: 1, name: 'Накладные' });
  await expect(title).toBeVisible();
  await expect(title).toBeFocused();
});

test('a page chunk that fails: one full reload, then «Не удалось загрузить страницу» with «Повторить»', async ({
  page,
}) => {
  await stand(page);
  let loads = 0;
  page.on('load', () => void loads++);
  await page.goto('/batches');
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
  await page.route(/\/assets\/waybills-[^/]+\.js$/, (route) => route.abort());
  await page.locator('.at-sidebar a[href="/waybills"]').click();
  const main = page.locator('main');
  await expect(main.getByText('Не удалось загрузить страницу.')).toBeVisible();
  await expect(main.getByRole('heading', { level: 1, name: 'Накладные' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Повторить' })).toBeVisible();
  await expect(page).toHaveURL(/\/waybills$/);
  expect(loads).toBe(2);
  await expect(page.getByText('Unexpected Application Error')).toHaveCount(0);
});
