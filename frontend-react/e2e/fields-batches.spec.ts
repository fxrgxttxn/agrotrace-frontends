import { expect, test, type Page } from '@playwright/test';
import { DEMO_PASSWORD, focusStaysIn, horizontalOverflow, signIn, unexpected, watch } from './helpers';

const SHOTS = 'test-results/shots/fields-batches';
const code = (n: number) => new RegExp(`^AT-\\d{4}-${String(n).padStart(6, '0')}$`);

async function shot(page: Page, name: string) {
  for (const width of [360, 1280])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      expect(await horizontalOverflow(page), `${name} ${width}`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `${SHOTS}/${name}-${width}-${theme}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('FARMER: fields, a field with its journal, a treatment, a new batch with the risk-model outcome', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'petrov@agrotrace.test', DEMO_PASSWORD, w);
  await page.goto('/fields');
  await expect(page.getByRole('heading', { level: 1, name: 'Поля' })).toBeVisible();
  const field = page.getByRole('link', { name: 'Низинное' });
  await expect(field).toBeVisible();
  await shot(page, 'fields');

  await field.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Низинное' })).toBeFocused();
  await expect(page.getByRole('heading', { level: 2, name: 'Обработки' })).toBeVisible();
  await shot(page, 'field');

  await page.getByRole('button', { name: 'Записать обработку' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Записать обработку' });
  await dialog.getByLabel('Препарат').selectOption({ index: 1 });
  await dialog.getByLabel('Доза').fill('0,5');
  const now = new Date();
  const today = [now.getDate(), now.getMonth() + 1, now.getFullYear()]
    .map((n) => String(n).padStart(2, '0'))
    .join('.');
  await dialog.getByLabel('Дата обработки').fill(today);
  await dialog.getByRole('button', { name: 'Записать обработку' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Обработка записана')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Изменить обработку: / }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Зарегистрировать партию' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Новая партия' })).toBeVisible();
  await expect(page.getByLabel('Поле').locator('option:checked')).toHaveText('Низинное');
  await page.getByLabel('Продукт').selectOption({ index: 1 });
  await page.getByLabel('Масса').fill('1500');
  await page.getByLabel('Дата уборки').fill(today);
  await shot(page, 'batch-new');
  await page.getByRole('button', { name: 'Зарегистрировать партию' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^AT-\d{4}-\d{6,}$/ })).toBeVisible();
  await expect(page.getByText(/зарегистрирована и направлена на анализ/)).toBeVisible();
  await expect(page.locator('.at-timeline__item').first()).toContainText('Партия зарегистрирована');
  expect(unexpected(w)).toEqual([]);
});

test('registry: filters and sort in the URL survive a reload; a batch card has every tab', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'molkombinat.head@agrotrace.test', DEMO_PASSWORD, w);
  await page.goto('/batches');
  await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
  await page.getByLabel('Статус').selectOption('Processed');
  await page.getByRole('button', { name: 'Масса, кг' }).click();
  await expect(page).toHaveURL(/status=Processed/);
  await expect(page).toHaveURL(/sort=massKg%2Casc|sort=massKg,asc/);
  await page.reload();
  await expect(page.getByLabel('Статус')).toHaveValue('Processed');
  await shot(page, 'batches');

  await page.getByPlaceholder('Код партии').fill('000006');
  await page.getByRole('link', { name: code(6) }).click();
  await expect(page.getByRole('tab', { name: 'История' })).toHaveAttribute('aria-selected', 'true');
  await shot(page, 'batch-history');
  for (const [tab, id] of [
    ['Путь', 'path'],
    ['Граф', 'graph'],
    ['Анализы', 'tests'],
    ['Документы', 'docs'],
  ] as const) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page).toHaveURL(new RegExp(`tab=${id}`));
    await shot(page, `batch-${id}`);
  }
  await page.getByRole('tab', { name: 'Граф' }).click();
  const related = page.getByRole('table', { name: 'Связанные партии' });
  await expect(related.getByText(code(5))).toBeVisible();
  await expect(related.getByText(code(7))).toBeVisible();
  await expect(
    page.getByRole('img', { name: /^Граф партии AT-\d{4}-000006: источников \d+, производных \d+$/ }),
  ).toBeVisible();
  expect(unexpected(w)).toEqual([]);
});

test('360 px: the graph opens full screen and closes with Esc', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, 'inspector@agrotrace.test', DEMO_PASSWORD, w);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/batches?q=000006');
  await page.getByRole('link', { name: code(6) }).click();
  await page.getByRole('tab', { name: 'Граф' }).click();
  await page.getByRole('button', { name: 'Открыть граф' }).click();
  await expect(page.locator('.at-graph[data-fullscreen] canvas').first()).toBeVisible();
  await focusStaysIn(page, '.at-graph[data-fullscreen]');
  await page.screenshot({ path: `${SHOTS}/graph-fullscreen-360.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Открыть граф' })).toBeFocused();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(unexpected(w)).toEqual([]);
});
