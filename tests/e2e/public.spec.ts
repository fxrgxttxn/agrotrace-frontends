import { expect, test, type Page } from '@playwright/test';
import { demoCode, fixClock, shot, signIn, unexpected, watch } from './helpers';

const SHOTS = 'public';
const ON_SALE = demoCode(2);
const RECALLED = demoCode(12);
const UNKNOWN = demoCode(999999);

const title = (page: Page) => page.getByRole('heading', { level: 1 });

test.beforeEach(({ page }) => fixClock(page));

test('UC-06: a batch on sale — status, origin, path, lab summary, photo credit', async ({ page }) => {
  const w = await watch(page);
  await page.goto(`/p/${ON_SALE}`);
  await expect(title(page)).toHaveText('Молоко пастеризованное 3,2%');
  await expect(page).toHaveTitle('Молоко пастеризованное 3,2% — AgroTrace');
  await expect(page.getByText('Безопасна', { exact: true })).toBeVisible();
  await expect(page.getByText(ON_SALE, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Происхождение' })).toBeVisible();
  const path = page.getByRole('listitem').filter({ hasText: /^с \d\d\.\d\d\.\d{4}/ });
  await expect(path).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 2, name: 'Анализы' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'NIAID' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'CC BY 2.0' })).toBeVisible();
  const loaded = await page.locator('main figure img').evaluate((img: HTMLImageElement) =>
    img.decode().then(
      () => img.naturalWidth,
      () => 0,
    ),
  );
  expect(loaded).toBeGreaterThan(0);
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await shot(page, SHOTS, 'public-on-sale');
  expect(unexpected(w)).toEqual([]);
});

test('a recalled batch: the large warning first, «do not consume»', async ({ page }) => {
  const w = await watch(page);
  await page.goto(`/p/${RECALLED}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Партия отозвана' })).toBeVisible();
  await expect(page.getByText('Не употребляйте продукт из этой партии.')).toBeVisible();
  await expect(page.getByText('Отозвана', { exact: true })).toBeVisible();
  await shot(page, SHOTS, 'public-recalled');
  expect(unexpected(w)).toEqual([]);
});

test('an unknown code: «not found», no raw error', async ({ page }) => {
  const w = await watch(page);
  await page.goto(`/p/${UNKNOWN}`);
  await expect(page.getByText('Партия с таким кодом не найдена.')).toBeVisible();
  await expect(title(page)).toHaveText('Партия');
  await shot(page, SHOTS, 'public-not-found');
  expect(unexpected(w, [new RegExp(`^http 404 GET /api/v1/public/batches/${UNKNOWN}$`)])).toEqual([]);
});

test('keyboard only: the complaint is sent with ALTCHA and reaches the inspector', async ({ page }) => {
  const w = await watch(page);
  await page.goto(`/p/${ON_SALE}`);
  await expect(title(page)).toHaveText('Молоко пастеризованное 3,2%');
  const report = page.getByRole('link', { name: 'Сообщить о проблеме' });
  await report.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/p/${ON_SALE}/complaint$`));
  await expect(title(page)).toHaveText('Сообщить о проблеме');
  await expect(title(page)).toBeFocused();
  await shot(page, SHOTS, 'public-complaint');

  const text = `Кислый вкус и хлопья в бутылке, e2e ${Date.now().toString(36)}`;
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Что случилось')).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press('Tab');
  await page.keyboard.type('+7 000 000-00-00');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Отправить жалобу' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Жалоба отправлена.')).toBeFocused({ timeout: 30000 });
  await shot(page, SHOTS, 'public-complaint-sent');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'К партии' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(title(page)).toHaveText('Молоко пастеризованное 3,2%');
  await expect(title(page)).toBeFocused();

  await signIn(page, 'inspector@agrotrace.test', w);
  await page.goto('/complaints');
  await expect(page.getByRole('heading', { level: 1, name: 'Жалобы' })).toBeVisible();
  await page.getByRole('link', { name: ON_SALE }).first().click();
  await expect(page.getByText(text)).toBeVisible();
  expect(unexpected(w)).toEqual([]);
});
