import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './api';

// Ruling FM11 against the real router and a real browser: a page chunk that cannot be loaded (aborted request) loads
// the target URL once more as a full document; failing again, the shell shows «Не удалось загрузить страницу» with
// «Повторить» at the target URL — no rolled-back or duplicate history entries. Entering the shell from a screen outside
// it while the page chunk loads shows the shell with the loading page in main and aria-current set.

const h1 = (name: string) => `h1.at-page__title:text-is("${name}")`;

/** Script chunks the `path` page needs beyond those of /batches (its own lazy page chunk). */
async function pageChunks(page: Page, path: string): Promise<string[]> {
  const seen = new Set<string>();
  const onRequest = (r: { url(): string; resourceType(): string }) => {
    if (r.resourceType() === 'script') seen.add(new URL(r.url()).pathname);
  };
  page.on('request', onRequest);
  await page.goto('/batches');
  await expect(page.locator(h1('Партии'))).toBeVisible();
  await page.waitForLoadState('networkidle');
  const before = new Set(seen);
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.locator(h1(path === '/fields' ? 'Поля' : ''))).toBeVisible();
  await page.waitForLoadState('networkidle');
  page.off('request', onRequest);
  return [...seen].filter((p) => !before.has(p));
}

test('a page chunk that fails twice: one reload, then the error page at the target URL, clean history', async ({
  page,
}) => {
  await mockApi(page);
  const chunks = await pageChunks(page, '/fields');
  expect(chunks.length).toBeGreaterThan(0);

  await page.goto('/batches');
  await expect(page.locator(h1('Партии'))).toBeVisible();
  const before = await page.evaluate(() => history.length);
  let aborted = 0;
  await page.route(
    (url) => chunks.includes(url.pathname),
    (route) => {
      aborted++;
      return route.abort();
    },
  );
  const loads: string[] = [];
  page.on('load', () => loads.push(page.url()));

  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.getByText('Не удалось загрузить страницу')).toBeVisible();
  await expect(page).toHaveURL(/\/fields$/);
  expect(loads.filter((u) => u.endsWith('/fields'))).toHaveLength(1); // exactly one full reload
  expect(aborted).toBeGreaterThanOrEqual(2);
  await expect(page.locator(h1('Поля'))).toBeVisible();
  await expect(page.locator('.at-shell .at-empty').getByRole('button', { name: 'Повторить' })).toBeVisible();
  await expect(page.locator('.at-sidebar a[href="/fields"]')).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  expect(await page.evaluate(() => sessionStorage.getItem('agrotrace-chunk-reload'))).toBeNull();

  // repeated clicks on the failing section add nothing to the history
  for (let i = 0; i < 3; i++) await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await expect(page).toHaveURL(/\/fields$/);

  // Back returns to the page before, as after any navigation
  await page.goBack();
  await expect(page).toHaveURL(/\/batches$/);
  await expect(page.locator(h1('Партии'))).toBeVisible();

  // once the chunk loads again, «Повторить» brings the page
  await page.unroute((url) => chunks.includes(url.pathname));
  await page.goForward();
  await expect(page).toHaveURL(/\/fields$/);
});

test('«Повторить» on the error page reloads and shows the page when the chunk is back', async ({ page }) => {
  await mockApi(page);
  const chunks = await pageChunks(page, '/fields');
  await page.goto('/batches');
  await expect(page.locator(h1('Партии'))).toBeVisible();
  const match = (url: URL) => chunks.includes(url.pathname);
  await page.route(match, (route) => route.abort());
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.getByText('Не удалось загрузить страницу')).toBeVisible();
  await page.unroute(match);
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.locator('.at-empty')).toHaveCount(0);
  await expect(page.locator(h1('Поля'))).toBeVisible();
  await expect(page).toHaveURL(/\/fields$/);
});

test('entering the shell from the login with a slow page chunk: shell, loading page in main, aria-current', async ({
  page,
}) => {
  await mockApi(page, { signedIn: false });
  await page.goto('/login?next=%2Ffields');
  await expect(page.locator(h1('Вход'))).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.route('**/assets/chunk-*.js', async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await page.getByLabel('Email').fill('petrov@agrotrace.test');
  await page.getByLabel('Пароль').fill('agrotrace-demo');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/fields$/, { timeout: 1000 });
  await expect(page.locator('.at-shell .at-shell__main > .at-page[aria-busy="true"]')).toBeVisible({
    timeout: 1000,
  });
  await expect(page.locator('.at-sidebar a[href="/fields"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('main.at-page')).toBeHidden(); // the login page is not on screen
  await expect(page.locator(h1('Поля'))).toBeFocused({ timeout: 8000 });
  await expect(page.locator('.at-shell')).toHaveCount(1);
});
