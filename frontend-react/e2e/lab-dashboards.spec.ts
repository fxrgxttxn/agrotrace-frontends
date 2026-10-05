import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD, horizontalOverflow, signIn, unexpected, watch } from './helpers';

async function noScrollAt360(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(300);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('INSPECTOR: the dashboard — metrics, rejected shares and regions as charts with a table view', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'inspector@agrotrace.test', DEMO_PASSWORD, w);
  await expect(page.getByRole('heading', { level: 1, name: 'Панель' })).toBeVisible();
  await expect(page.getByText('Партий за период')).toBeVisible();
  await expect(page.getByText('Среднее время отзыва')).toBeVisible();
  const card = page.locator('.at-card', {
    has: page.getByRole('heading', { name: 'Доля брака по продуктам' }),
  });
  const canvas = card.locator('.at-chart__canvas');
  if (await canvas.count()) {
    await expect(canvas.locator('svg')).toBeVisible();
    await expect(canvas).toHaveAttribute('aria-label', /^Доля брака по продуктам: /);
    await card.getByText('Таблица значений').click();
    await expect(card.getByRole('table', { name: 'Доля брака по продуктам' })).toBeVisible();
  } else await expect(card.getByText('За период данных нет.')).toBeVisible();
  await noScrollAt360(page);
  expect(unexpected(w)).toEqual([]);
});

test('FARMER: the organization dashboard — batches by status (11 bars)', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, 'petrov@agrotrace.test', DEMO_PASSWORD, w);
  await expect(page.getByText('Партий у организации')).toBeVisible();
  const canvas = page.locator('.at-card', { has: page.getByRole('heading', { name: 'Партии по статусам' }) });
  await expect(canvas.locator('.at-chart__canvas svg')).toBeVisible();
  await expect(canvas.locator('.at-chart__canvas')).toHaveAttribute(
    'aria-label',
    /Создана — \d+;.*Списана — \d+$/,
  );
  await noScrollAt360(page);
  expect(unexpected(w)).toEqual([]);
});

test('LAB: the dashboard, the queue with the overdue filter, a test card with the live comparison', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'vetlab.analyst@agrotrace.test', DEMO_PASSWORD, w);
  await expect(page.getByText('Среднее время анализа')).toBeVisible();
  await expect(page.locator('.at-chart')).toHaveCount(0);

  await page.getByRole('link', { name: 'Очередь проб' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Очередь проб' })).toBeVisible();
  await page.getByLabel('Просрочка').selectOption({ label: 'Только просроченные' });
  await expect(page).toHaveURL(/overdue=true/);
  await page.getByLabel('Просрочка').selectOption({ label: 'Все' });
  await page.getByLabel('Статус').selectOption({ label: 'Проба отобрана' });
  await expect(page).toHaveURL(/status=SAMPLED/);
  await noScrollAt360(page);

  await page
    .getByRole('link', { name: /^AT-\d{4}-\d{6}$/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: /^Анализ AT-/ })).toBeVisible();
  const values = page.getByLabel(/^Значение: /);
  await expect(values.first()).toBeVisible();
  await values.first().fill('99999999');
  await expect(page.getByText('Превышение', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Заключение: Превышение нормативов')).toBeVisible();
  for (const v of (await values.all()).slice(1)) await v.fill('0');
  await page.getByRole('button', { name: 'Внести результаты' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Внести и запустить отзыв' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await noScrollAt360(page);
  expect(unexpected(w)).toEqual([]);
});

test('INSPECTOR: the unscheduled test dialog on a batch card (cancelled)', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, 'inspector@agrotrace.test', DEMO_PASSWORD, w);
  await page.goto('/batches');
  await page
    .getByRole('link', { name: /^AT-\d{4}-\d{6}$/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Назначить анализ' }).click();
  const dialog = page.getByRole('dialog', { name: /^Внеплановый анализ партии AT-/ });
  await dialog.getByRole('combobox', { name: 'Лаборатория' }).fill('АНО');
  const option = page.getByRole('listbox', { name: 'Лаборатория' }).getByRole('option').first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(dialog.getByRole('combobox', { name: 'Лаборатория' })).toHaveValue(/^АНО «Ветеринарный/);
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toBeHidden();
  expect(unexpected(w)).toEqual([]);
});
