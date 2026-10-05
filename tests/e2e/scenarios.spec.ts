import { expect, test, type Page } from '@playwright/test';
import { horizontalOverflow, settle, signIn, signOut, unexpected, watch } from './helpers';

const title = (page: Page) => page.getByRole('heading', { level: 1 });
const CODE = /^AT-\d{4}-\d{6}$/;
const LAB_HEADS: [RegExp, string][] = [
  [/Клязьма/, 'vetlab.head@agrotrace.test'],
  [/АгроТест/, 'agrotest.head@agrotrace.test'],
];

function today(): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date());
  return parts;
}

async function harvest(page: Page, field: string, product: string, mass: string) {
  await page.goto('/fields');
  await page.getByRole('main').getByRole('link', { name: field }).first().click();
  await expect(title(page)).toHaveText(field);
  await page.getByRole('link', { name: 'Зарегистрировать партию' }).click();
  await expect(title(page)).toHaveText('Новая партия');
  await page.getByLabel('Продукт').selectOption({ label: product });
  await page.getByLabel('Масса').fill(mass);
  await page.getByLabel('Дата уборки').fill(today());
  await page.getByRole('button', { name: 'Зарегистрировать партию' }).click();
  await expect(title(page)).toHaveText(CODE, { timeout: 20000 });
  const code = (await title(page).textContent())!;
  const toast = page.getByText(new RegExp(`^Партия ${code} зарегистрирована`));
  await expect(toast).toBeVisible();
  return { code, toLab: /направлена на анализ/.test((await toast.textContent()) ?? '') };
}

async function openTest(page: Page, code: string) {
  await page.goto('/lab/tests');
  await expect(title(page)).toHaveText('Очередь проб');
  await page.getByRole('searchbox', { name: 'Поиск анализов' }).fill(code);
  await page.getByRole('main').getByRole('link', { name: code }).first().click();
  await expect(title(page)).toHaveText(`Анализ ${code}`);
}

test('end-to-end recall: harvest → laboratory FAIL → recall → withdrawal → warning on the QR page', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'petrov@agrotrace.test', w);
  await page.goto('/fields');
  await page.getByRole('main').getByRole('link', { name: 'Низинное' }).first().click();
  await expect(title(page)).toHaveText('Низинное');
  await page.getByRole('button', { name: 'Записать обработку' }).first().click();
  const treatment = page.getByRole('dialog', { name: 'Записать обработку' });
  await treatment.getByLabel('Препарат').selectOption({ index: 1 });
  await treatment.getByLabel('Доза').fill('0,5');
  await treatment.getByLabel('Дата обработки').fill(today());
  await treatment.getByRole('button', { name: 'Записать обработку' }).click();
  await expect(page.getByText('Обработка записана')).toBeVisible();
  const { code, toLab } = await harvest(page, 'Низинное', 'Пшеница мягкая', '1500');
  expect(toLab).toBe(true);
  await page.getByRole('tab', { name: 'Анализы' }).click();
  await settle(page);
  const tests = await page.getByRole('main').textContent();
  const lab = LAB_HEADS.find(([name]) => name.test(tests ?? ''));
  expect(lab, 'the laboratory of the test is shown on the batch card').toBeDefined();
  await signOut(page);

  await signIn(page, lab![1], w);
  await openTest(page, code);
  await page.getByRole('button', { name: 'Зарегистрировать пробу' }).click();
  await expect(page.getByText(`Проба партии ${code} зарегистрирована`)).toBeVisible();
  const values = page.getByLabel(/^Значение: /);
  await expect(values.first()).toBeEnabled();
  const all = await values.all();
  await all[0]!.fill('99999');
  for (const v of all.slice(1)) await v.fill('0');
  await expect(page.getByText('Заключение: Превышение нормативов')).toBeVisible();
  await page.getByRole('button', { name: 'Внести результаты' }).click();
  const fail = page.getByRole('dialog', { name: `Превышение нормативов: партия ${code}` });
  await fail.getByLabel('Код партии для подтверждения').fill(code);
  await fail.getByRole('button', { name: 'Внести и запустить отзыв' }).click();
  await expect(
    page.getByText(`Результаты внесены: превышение нормативов. По партии ${code} запущен отзыв.`),
  ).toBeVisible();
  await signOut(page);

  await signIn(page, 'petrov@agrotrace.test', w);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/recall-tasks');
  await expect(title(page)).toHaveText('Задачи отзыва');
  const withdrawn = page.getByRole('button', { name: `Изъято: ${code}` });
  await expect(withdrawn).toBeVisible();
  expect((await withdrawn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await withdrawn.click();
  const confirm = page.getByRole('dialog', { name: `Изъятие партии ${code}` });
  await confirm.getByLabel('Код партии для подтверждения').fill(code);
  await confirm.getByRole('button', { name: 'Подтвердить изъятие' }).click();
  await expect(page.getByText(`Изъятие партии ${code} подтверждено`)).toBeVisible();
  await expect(withdrawn).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signOut(page);

  await page.goto(`/p/${code}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Партия отозвана' })).toBeVisible();
  await expect(page.getByText('Не употребляйте продукт из этой партии.')).toBeVisible();
  await expect(page.getByText('Отозвана', { exact: true })).toBeVisible();
  expect(unexpected(w)).toEqual([]);
});

test('UC-02: a farmer registers a harvest and ships it to a processor, who accepts it', async ({ page }) => {
  const w = await watch(page);
  await signIn(page, 'petrov@agrotrace.test', w);
  let batch = await harvest(page, 'Пастбище у Колокши', 'Молоко сырое коровье', '800');
  for (let i = 0; batch.toLab && i < 4; i++)
    batch = await harvest(page, 'Пастбище у Колокши', 'Молоко сырое коровье', '800');
  expect(batch.toLab).toBe(false);
  const { code } = batch;
  await expect(page.getByText('Допущена', { exact: true }).first()).toBeVisible();

  await page.goto('/waybills/new');
  await expect(title(page)).toHaveText('Новая накладная');
  await page.getByRole('combobox', { name: 'Получатель' }).fill('ООО «Молк');
  await page.getByRole('listbox', { name: 'Получатель' }).getByRole('option').first().click();
  const pick = page.getByRole('checkbox', { name: `Выбрать ${code}` });
  await pick.focus();
  await page.keyboard.press('Space');
  await expect(pick).toBeChecked();
  await page.getByRole('button', { name: 'Создать накладную' }).click();
  await expect(title(page)).toHaveText(/^WB-\d{4}-\d{6}$/, { timeout: 20000 });
  const number = (await title(page).textContent())!;
  await expect(page.getByText(`Черновик ${number} создан`)).toBeVisible();
  await page.getByRole('button', { name: 'Отгрузить' }).click();
  await expect(page.getByText(`Накладная ${number} отправлена, партии в пути`)).toBeVisible();
  await expect(page.getByText('Отправлена', { exact: true }).first()).toBeVisible();
  await signOut(page);

  await signIn(page, 'molkombinat.head@agrotrace.test', w);
  await page.goto('/waybills?direction=incoming&status=SENT');
  await expect(title(page)).toHaveText('Накладные');
  await page.getByRole('main').getByRole('link', { name: number }).click();
  await expect(title(page)).toHaveText(number);
  await page.getByLabel(`Фактическая масса ${code}`).fill('800');
  await page.getByRole('button', { name: 'Принять' }).click();
  await expect(page.getByText(`Накладная ${number} принята`)).toBeVisible();
  await page.goto('/stock');
  await expect(page.getByRole('main').getByText(code)).toBeVisible();
  expect(unexpected(w)).toEqual([]);
});

test('UC-03: a laboratory takes the sample of a queued test and records results within the norms', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'vetlab.head@agrotrace.test', w);
  await page.goto('/lab/tests?status=QUEUED');
  await expect(title(page)).toHaveText('Очередь проб');
  await expect(page.getByLabel('Статус')).toHaveValue('QUEUED');
  await settle(page);
  const link = page.getByRole('main').getByRole('link', { name: CODE }).first();
  const code = (await link.textContent())!.trim();
  await link.click();
  await expect(title(page)).toHaveText(`Анализ ${code}`);
  await page.getByRole('button', { name: 'Зарегистрировать пробу' }).click();
  await expect(page.getByText(`Проба партии ${code} зарегистрирована`)).toBeVisible();
  const values = page.getByLabel(/^Значение: /);
  await expect(values.first()).toBeEnabled();
  for (const v of await values.all()) await v.fill('0');
  await expect(page.getByText('Заключение: Соответствует нормативам')).toBeVisible();
  await page.getByRole('button', { name: 'Внести результаты' }).click();
  await expect(page.getByText('Результаты внесены: Соответствует нормативам')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Внести результаты' })).toHaveCount(0);
  expect(unexpected(w)).toEqual([]);
});

test('UC-08: a laboratory FAIL starts the recall by itself; the inspector sees it with its affected batches', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'vetlab.head@agrotrace.test', w);
  await page.goto('/lab/tests?status=SAMPLED');
  await expect(page.getByLabel('Статус')).toHaveValue('SAMPLED');
  await settle(page);
  const link = page.getByRole('main').getByRole('link', { name: CODE }).first();
  const code = (await link.textContent())!.trim();
  await link.click();
  await expect(title(page)).toHaveText(`Анализ ${code}`);
  const values = page.getByLabel(/^Значение: /);
  const all = await values.all();
  await all[0]!.fill('99999');
  for (const v of all.slice(1)) await v.fill('0');
  await page.getByRole('button', { name: 'Внести результаты' }).click();
  const fail = page.getByRole('dialog', { name: `Превышение нормативов: партия ${code}` });
  await fail.getByLabel('Код партии для подтверждения').fill(code);
  await fail.getByRole('button', { name: 'Внести и запустить отзыв' }).click();
  await expect(
    page.getByText(`Результаты внесены: превышение нормативов. По партии ${code} запущен отзыв.`),
  ).toBeVisible();
  await signOut(page);

  await signIn(page, 'inspector@agrotrace.test', w);
  await page.goto('/recalls');
  await expect(title(page)).toHaveText('Отзывы');
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: code }) });
  await expect(row.getByText('Лабораторный анализ')).toBeVisible();
  await row.getByRole('link', { name: code }).click();
  await expect(title(page)).toHaveText(`Отзыв ${code}`);
  await expect(page.getByRole('table', { name: 'Затронутые партии' }).getByText(code)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Задачи изъятия' })).toBeVisible();
  expect(unexpected(w)).toEqual([]);
});
