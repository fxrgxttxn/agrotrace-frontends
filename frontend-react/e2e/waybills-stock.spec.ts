import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD, horizontalOverflow, signIn, unexpected, watch } from './helpers';

test('FARMER: a draft waybill from the own stock, then deleted', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, 'petrov@agrotrace.test', DEMO_PASSWORD, w);
  await page.goto('/waybills/new');
  await expect(page.getByRole('heading', { level: 1, name: 'Новая накладная' })).toBeVisible();
  const receiver = page.getByRole('combobox', { name: 'Получатель' });
  await receiver.fill('ООО «Мель');
  await page.getByRole('listbox', { name: 'Получатель' }).getByRole('option').first().click();
  await page
    .getByRole('checkbox', { name: /^Выбрать AT-/ })
    .first()
    .check({ force: true });
  await page.getByRole('button', { name: 'Создать накладную' }).click();
  await expect(page).toHaveURL(/\/waybills\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: /^WB-\d{4}-\d{6}$/ })).toBeVisible();
  await expect(page.getByText('Черновик').first()).toBeVisible();
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Удалить черновик' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить черновик' }).click();
  await expect(page).toHaveURL(/\/waybills$/);
  expect(unexpected(w)).toEqual([]);
});

test('RETAILER: incoming waybills; the acceptance counts the discrepancy live (BR-07)', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, 'lavka.head@agrotrace.test', DEMO_PASSWORD, w);
  await page.goto('/waybills?direction=incoming&status=SENT');
  await expect(page.getByRole('heading', { level: 1, name: 'Накладные' })).toBeVisible();
  await page
    .getByRole('link', { name: /^WB-\d{4}-\d{6}$/ })
    .first()
    .click();
  const actual = page.getByLabel(/^Фактическая масса AT-/).first();
  await actual.fill('1');
  await expect(page.getByText('Больше 2%: нужен акт').first()).toBeVisible();
  await expect(page.getByLabel(/^Акт расхождения AT-/).first()).toBeVisible();
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(unexpected(w)).toEqual([]);
});

test('PROCESSOR: the processing wizard shows the live mass balance (BR-04)', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, 'molkombinat.head@agrotrace.test', DEMO_PASSWORD, w);
  await page.goto('/processing/new');
  await expect(page.getByRole('heading', { level: 1, name: 'Переработка' })).toBeVisible();
  await page
    .getByRole('checkbox', { name: /^Выбрать AT-/ })
    .first()
    .check({ force: true });
  await page.getByLabel('Продукт выхода 1').selectOption({ index: 1 });
  await page.getByLabel('Масса выхода 1').fill('999999');
  await expect(page.getByText(/^Выход переработки .* больше допустимого/)).toBeVisible();
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.getByRole('heading', { name: 'Входы' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(unexpected(w)).toEqual([]);
});

test('RETAILER: stock and QR printing', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, 'provizia.head@agrotrace.test', DEMO_PASSWORD, w);
  await page.goto('/stock');
  await expect(page.getByRole('heading', { level: 1, name: 'Склад' })).toBeVisible();
  await page.goto('/qr');
  await expect(page.getByRole('heading', { level: 1, name: 'Печать QR' })).toBeVisible();
  await page
    .getByRole('button', { name: /^Скачать QR-код AT-/ })
    .first()
    .click();
  await expect(page.getByRole('dialog').getByRole('link', { name: /PNG/ })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(unexpected(w)).toEqual([]);
});
