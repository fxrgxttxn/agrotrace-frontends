import { expect, test, type Page } from '@playwright/test';
import { DEMO_PASSWORD, horizontalOverflow, signIn, signOut, unexpected, watch } from './helpers';

// Task 6 on the mock stand (react-mock.localhost, ruling FM23; demo world of docs/demo-accounts.md, codes matched by
// number): the inspector's registry and card of recall № 1 (AT-…-000010: 1 of 4 confirmed, 3 overdue), a manual
// recall of AT-…-000002 confirmed with the batch code, the holder (Провизия) withdrawing it at 360 px — the recall then
// closes (BR-10); complaints: AT-…-000025 (NEW) taken into review and sent to a laboratory, AT-…-000008 (IN_REVIEW)
// decided as a recall (the batch is already «Отозвана» in recall № 2: the new recall of it gets no task and closes at once,
// BR-10). Screenshots 360/1280 light/dark.

const SHOTS = 'test-results/shots/task6';
const code = (n: number) => new RegExp(`^AT-\\d{4}-${String(n).padStart(6, '0')}$`);
const named = (prefix: string, n: number) => new RegExp(`^${prefix}AT-\\d{4}-${String(n).padStart(6, '0')}$`);

async function shot(page: Page, name: string) {
  for (const width of [360, 1280])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(150);
      expect(await horizontalOverflow(page), `${name} ${width} ${theme}`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `${SHOTS}/${name}-${width}-${theme}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('INSPECTOR starts a recall, the holder withdraws the batch at 360 px, the recall closes (BR-10)', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'inspector@agrotrace.test', DEMO_PASSWORD, w);
  await page.goto('/recalls');
  await expect(page.getByRole('heading', { level: 1, name: 'Отзывы' })).toBeVisible();
  await expect(page.getByRole('link', { name: code(10) })).toBeVisible();
  await shot(page, 'recalls');

  // Recall № 1: one task confirmed of four, three overdue.
  await page.getByRole('link', { name: code(10) }).click();
  await expect(page.getByRole('heading', { level: 1, name: named('Отзыв ', 10) })).toBeVisible();
  await expect(page.locator('.at-card').first().getByText('1 из 4')).toBeVisible();
  await expect(page.getByText('просрочено: 3').first()).toBeVisible();
  const tasks = page.getByRole('table', { name: 'Задачи изъятия' });
  await expect(tasks.getByText(/^просрочено на /).first()).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Затронутые партии' }).getByText('Производная, уровень 2').first(),
  ).toBeVisible();
  await shot(page, 'recall');

  // Manual start: the batch found by its code, confirmed with the code repeated.
  await page.goto('/recalls/new');
  await expect(page.getByRole('heading', { level: 1, name: 'Новый отзыв' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Исходная партия' }).fill('000002');
  await page.getByRole('listbox', { name: 'Исходная партия' }).getByRole('option').first().click();
  const picked = await page.getByRole('combobox', { name: 'Исходная партия' }).inputValue();
  expect(picked).toMatch(code(2));
  await page.getByLabel('Причина').fill('Плановая проверка: нарушение температурного режима хранения.');
  await page.getByRole('button', { name: 'Запустить отзыв' }).click();
  const dialog = page.getByRole('dialog', { name: `Запустить отзыв партии ${picked}` });
  await expect(dialog.getByLabel('Код партии для подтверждения')).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Запустить отзыв' })).toBeDisabled();
  await dialog.getByLabel('Код партии для подтверждения').fill(picked.toLowerCase());
  await shot(page, 'recall-new-confirm');
  await dialog.getByRole('button', { name: 'Запустить отзыв' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Отзыв ${picked}` })).toBeVisible();
  await expect(page.getByText(`Отзыв по партии ${picked} запущен`)).toBeVisible();
  await expect(page.locator('.at-card').first().getByText('0 из 1')).toBeVisible();
  const recallUrl = page.url();
  expect(unexpected(w)).toEqual([]);
  await signOut(page);

  // The holder: the task with its timer; «Изъято» on the phone.
  await signIn(page, 'provizia.head@agrotrace.test', DEMO_PASSWORD, w);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/recall-tasks');
  await expect(page.getByRole('heading', { level: 1, name: 'Задачи отзыва' })).toBeVisible();
  const confirm = page.getByRole('button', { name: `Изъято: ${picked}` });
  await expect(confirm).toBeVisible();
  await expect(page.getByText(/^осталось 23 ч \d+ мин$/).first()).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  const box = await confirm.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, 'recall-tasks');
  await page.setViewportSize({ width: 360, height: 780 });
  await confirm.click();
  const withdraw = page.getByRole('dialog', { name: `Изъятие партии ${picked}` });
  await withdraw.getByLabel('Код партии для подтверждения').fill(picked);
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot(page, 'recall-task-confirm');
  await page.setViewportSize({ width: 360, height: 780 });
  await withdraw.getByRole('button', { name: 'Подтвердить изъятие' }).click();
  await expect(page.getByText(`Изъятие партии ${picked} подтверждено`)).toBeVisible();
  await expect(page.getByRole('button', { name: `Изъято: ${picked}` })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(unexpected(w)).toEqual([]);
  await signOut(page);

  // BR-10: the last task confirmed — the recall is closed.
  await signIn(page, 'inspector@agrotrace.test', DEMO_PASSWORD, w);
  await page.goto(recallUrl);
  await expect(page.locator('.at-card').first().locator('.at-chip', { hasText: 'Закрыт' })).toBeVisible();
  await expect(page.locator('.at-card').first().getByText('1 из 1')).toBeVisible();
  expect(unexpected(w)).toEqual([]);
});

test('INSPECTOR: complaints — take into review and assign a test; decide a recall (no task left: closed at once)', async ({
  page,
}) => {
  const w = await watch(page);
  await signIn(page, 'inspector@agrotrace.test', DEMO_PASSWORD, w);
  await page.goto('/complaints');
  await expect(page.getByRole('heading', { level: 1, name: 'Жалобы' })).toBeVisible();
  await expect(page.getByRole('link', { name: code(25) })).toBeVisible();
  await shot(page, 'complaints');

  await page.getByRole('link', { name: code(25) }).click();
  await expect(page.getByRole('heading', { level: 1, name: named('Жалоба на партию ', 25) })).toBeVisible();
  await page.getByRole('button', { name: 'Взять в работу' }).click();
  await expect(page.getByText('Жалоба взята в работу')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Взять в работу' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Назначить анализ' }).check({ force: true });
  await page.getByLabel('Комментарий').fill('Назначен анализ на остаточные пестициды.');
  await page.getByRole('combobox', { name: 'Лаборатория' }).fill('АНО');
  await page.getByRole('listbox', { name: 'Лаборатория' }).getByRole('option').first().click();
  await shot(page, 'complaint-decision');
  await page.getByRole('button', { name: 'Назначить анализ' }).click();
  await expect(page.getByText(/^Анализ партии AT-\d{4}-000025 назначен$/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Анализы партии' })).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(0);

  await page.goto('/complaints?status=IN_REVIEW');
  await page.getByRole('link', { name: code(8) }).click();
  await expect(page.getByRole('heading', { level: 1, name: named('Жалоба на партию ', 8) })).toBeVisible();
  await page.getByRole('radio', { name: 'Запустить отзыв' }).check({ force: true });
  await page.getByLabel('Комментарий').fill('Жалоба подтверждена: партия уже отзывается.');
  await page.getByRole('button', { name: 'Запустить отзыв' }).click();
  const dialog = page.getByRole('dialog', { name: named('Запустить отзыв партии ', 8) });
  const batch = ((await page.getByRole('heading', { level: 1 }).textContent()) ?? '').replace(
    'Жалоба на партию ',
    '',
  );
  await dialog.getByLabel('Код партии для подтверждения').fill(batch);
  await dialog.getByRole('button', { name: 'Запустить отзыв' }).click();
  await expect(page.getByText(`Решение принято: отзыв по партии ${batch}`)).toBeVisible();
  await page.getByRole('link', { name: 'Открыть отзыв' }).click();
  // The batch was already recalled (recall № 2): the recall of it creates no task and is closed at once (BR-10).
  await expect(page.getByRole('heading', { level: 1, name: named('Отзыв ', 8) })).toBeVisible();
  await expect(page.locator('.at-card').first().locator('.at-chip', { hasText: 'Закрыт' })).toBeVisible();
  await expect(
    page.getByText('Задач изъятия нет: ни одна партия не перешла в статус «Отозвана».'),
  ).toBeVisible();
  await shot(page, 'recall-closed');
  expect(unexpected(w)).toEqual([]);
});
