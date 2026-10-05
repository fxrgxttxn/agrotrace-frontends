import { expect, test } from '@playwright/test';
import { stand } from './stand';

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

test('a superseded navigation whose chunk fails never reloads; the next visit asks for the chunk again', async ({
  page,
}) => {
  await stand(page);
  let loads = 0;
  page.on('load', () => void loads++);
  await page.goto('/batches');
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
  let fail: () => void = () => {};
  const failed = new Promise<void>((r) => (fail = r));
  let attempts = 0;
  await page.route(/\/assets\/waybills-[^/]+\.js$/, async (route) => {
    attempts++;
    if (attempts === 1) {
      await failed;
      return route.abort();
    }
    return route.continue();
  });
  await page.locator('.at-sidebar a[href="/waybills"]').click();
  await expect(page.locator('main [aria-busy="true"]')).toBeVisible();
  await page.locator('.at-sidebar a[href="/batches"]').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
  fail();
  await page.waitForTimeout(500);
  expect(loads).toBe(1);
  await expect(page).toHaveURL(/\/batches$/);
  await page.locator('.at-sidebar a[href="/waybills"]').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Накладные' })).toBeVisible();
  await expect(page.getByText('Не удалось загрузить страницу.')).toHaveCount(0);
  expect(attempts).toBeGreaterThanOrEqual(2);
  expect(loads).toBeLessThanOrEqual(2);
});

test('a bootstrap chunk that fails: one reload, then the plain message with «Повторить»', async ({
  page,
}) => {
  await stand(page);
  let loads = 0;
  page.on('load', () => void loads++);
  await page.route(/\/assets\/main-[^/]+\.js$/, (route) => route.abort());
  await page.goto('/batches');
  await expect(page.getByText('Не удалось загрузить страницу.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
  expect(loads).toBe(2);
});

test('the chart library chunk fails: every chart says so; «Повторить» loads the page anew, then they draw', async ({
  page,
}) => {
  await stand(page, {
    getMe: (_u: URL, example: unknown) => ({
      ...(example as Record<string, unknown>),
      roles: ['INSPECTOR'],
      organization: {
        id: 'f1a2b3c4-5000-4000-8000-000000000900',
        name: 'Инспекция',
        type: 'AUTHORITY',
        logoUrl: null,
      },
    }),
  });
  let loads = 0;
  let asked = 0;
  let block = true;
  page.on('load', () => void loads++);
  await page.route(/\/assets\/echarts-[^/]+\.js$/, (route) => {
    asked++;
    return block ? route.abort() : route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.locator('.at-chart__failed')).toHaveCount(3);
  await expect(page.locator('.at-chart__failed').first().getByRole('alert')).toHaveText(
    'График не загрузился.',
  );
  await page.waitForTimeout(500);
  expect(asked).toBe(1);
  block = false;
  await page.locator('.at-chart__failed').first().getByRole('button', { name: 'Повторить' }).click();
  await expect(page.locator('.at-chart__canvas svg')).toHaveCount(3);
  expect(loads).toBe(2);
  await expect(page.locator('.at-chart__failed')).toHaveCount(0);
});
