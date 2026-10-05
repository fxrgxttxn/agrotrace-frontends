import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './api';
import { PRODUCTION } from './helpers';

test.use(PRODUCTION);

const h1 = (name: string) => `h1.at-page__title:text-is("${name}")`;

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
  const fieldsChunk = (url: URL) => chunks.includes(url.pathname);
  await page.route(fieldsChunk, (route) => {
    aborted++;
    return route.abort();
  });
  const loads: string[] = [];
  page.on('load', () => loads.push(page.url()));

  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.getByText('Не удалось загрузить страницу.')).toBeVisible();
  await expect(page).toHaveURL(/\/fields$/);
  expect(loads.filter((u) => u.endsWith('/fields'))).toHaveLength(1);
  expect(aborted).toBeGreaterThanOrEqual(2);
  await expect(page.locator(h1('Поля'))).toBeVisible();
  await expect(page.locator('.at-shell .at-empty').getByRole('button', { name: 'Повторить' })).toBeVisible();
  await expect(page.locator('.at-sidebar a[href="/fields"]')).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  expect(await page.evaluate(() => sessionStorage.getItem('agrotrace-chunk-reload'))).toBeNull();

  for (let i = 0; i < 3; i++) await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await expect(page).toHaveURL(/\/fields$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/batches$/);
  await expect(page.locator(h1('Партии'))).toBeVisible();

  await page.unroute(fieldsChunk);
  await page.goForward();
  await expect(page).toHaveURL(/\/fields$/);
  await expect(page.locator(h1('Поля'))).toBeVisible();
  await expect(page.locator('.at-empty')).toHaveCount(0);
  await expect(page.getByText('Не удалось загрузить страницу.')).toHaveCount(0);
});

async function slowFailingChunk(page: Page, chunks: string[], ms: number): Promise<void> {
  await page.route(
    (url) => chunks.includes(url.pathname),
    async (route) => {
      await new Promise((r) => setTimeout(r, ms));
      await route.abort().catch(() => {});
    },
  );
}

test('a failing chunk of a navigation the user already left (another link) reloads nothing', async ({
  page,
}) => {
  await mockApi(page);
  const chunks = await pageChunks(page, '/fields');
  await page.goto('/batches');
  await expect(page.locator(h1('Партии'))).toBeVisible();
  await slowFailingChunk(page, chunks, 2000);
  const loads: string[] = [];
  page.on('load', () => loads.push(page.url()));
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await page.waitForTimeout(300);
  await page.locator('.at-sidebar').getByRole('link', { name: 'Накладные' }).click();
  await expect(page.locator(h1('Накладные'))).toBeVisible();
  await page.waitForTimeout(2500);
  expect(loads).toEqual([]);
  await expect(page).toHaveURL(/\/waybills$/);
  await expect(page.locator(h1('Накладные'))).toBeVisible();
  await expect(page.locator('.at-empty')).toHaveCount(0);
});

test('a failing chunk after Back reloads nothing, the page before stays', async ({ page }) => {
  await mockApi(page);
  const chunks = await pageChunks(page, '/fields');
  await page.goto('/batches');
  await expect(page.locator(h1('Партии'))).toBeVisible();
  await slowFailingChunk(page, chunks, 2000);
  const loads: string[] = [];
  page.on('load', () => loads.push(page.url()));
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await page.waitForTimeout(300);
  await page.goBack();
  await expect(page).toHaveURL(/\/batches$/);
  await page.waitForTimeout(2500);
  expect(loads).toEqual([]);
  await expect(page.locator(h1('Партии'))).toBeVisible();
  await expect(page.locator('.at-empty')).toHaveCount(0);
});

test('after the error page, the next navigation to the route imports the chunk again', async ({ page }) => {
  await mockApi(page);
  const chunks = await pageChunks(page, '/fields');
  await page.goto('/batches');
  await expect(page.locator(h1('Партии'))).toBeVisible();
  const match = (url: URL) => chunks.includes(url.pathname);
  await page.route(match, (route) => route.abort());
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.getByText('Не удалось загрузить страницу.')).toBeVisible();
  await page.unroute(match);
  await page.locator('.at-sidebar').getByRole('link', { name: 'Партии' }).click();
  await expect(page.locator(h1('Партии'))).toBeFocused();
  const documents: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
  });
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.locator(h1('Поля'))).toBeVisible();
  await expect(page.locator('.at-empty')).toHaveCount(0);
  await expect(page).toHaveURL(/\/fields$/);
  expect(documents).toEqual(['/fields']);
});

test('the app chunk itself fails at start: one reload, then a plain message with «Повторить» (no blank page)', async ({
  page,
}) => {
  await mockApi(page, { signedIn: false });
  await page.goto('/login');
  await expect(page.locator(h1('Вход'))).toBeVisible();
  const preloaded = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="modulepreload"]')].map(
      (l) => new URL((l as HTMLLinkElement).href).pathname,
    ),
  );
  const everyChunk = (url: URL) =>
    /^\/assets\/chunk-.*\.js$/.test(url.pathname) && !preloaded.includes(url.pathname);
  await page.route(everyChunk, (route) => route.abort());
  const documents: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
  });
  await page.reload();
  await expect(page.getByText('Не удалось загрузить страницу.')).toBeVisible();
  await page.waitForTimeout(500);
  expect(documents).toEqual(['/login', '/login']);
  await expect(
    page.locator('main.at-page > article.at-card > .at-empty > button.at-button[data-variant="primary"]'),
  ).toHaveText('Повторить');
  await expect(page.locator('h1')).toHaveCount(0);
  await expect(page.locator('#boot-fallback')).toHaveCount(0);
  const retry = page.getByRole('button', { name: 'Повторить' });
  await expect(retry).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('agrotrace-chunk-reload'))).toBeNull();
  await page.unroute(everyChunk);
  await retry.click();
  await expect(page.locator(h1('Вход'))).toBeVisible();
  await expect(page.getByText('Не удалось загрузить страницу.')).toHaveCount(0);
});

test('«Повторить» on the error page reloads and shows the page when the chunk is back', async ({ page }) => {
  await mockApi(page);
  const chunks = await pageChunks(page, '/fields');
  await page.goto('/batches');
  await expect(page.locator(h1('Партии'))).toBeVisible();
  const match = (url: URL) => chunks.includes(url.pathname);
  await page.route(match, (route) => route.abort());
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.getByText('Не удалось загрузить страницу.')).toBeVisible();
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
  await expect(page.locator('main.at-page')).toBeHidden();
  await expect(page.locator(h1('Поля'))).toBeFocused({ timeout: 8000 });
  await expect(page.locator('.at-shell')).toHaveCount(1);
});

test('the entry script itself cannot load — index.html shows its static fallback after 10 s, a JS-free retry', async ({
  page,
}) => {
  await mockApi(page, { signedIn: false });
  const entry = /\/assets\/main-[^/]*\.js$/;
  await page.route(entry, (route) => route.abort());
  await page.goto('/batches?page=2');
  const fallback = page.locator('#boot-fallback');
  await expect(fallback).toBeAttached();
  await expect(fallback).toBeHidden();
  await expect(fallback).toBeVisible({ timeout: 12000 });
  await expect(fallback.locator('.at-empty__text')).toHaveText('Не удалось загрузить страницу.');
  const retry = fallback.getByRole('link', { name: 'Повторить' });
  await expect(retry).toHaveAttribute('href', '');
  await page.unroute(entry);
  await retry.click();
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.locator(h1('Вход'))).toBeVisible();
  await expect(fallback).toHaveCount(0);
});

test('a normal start removes the static fallback at once', async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto('/login');
  await expect(page.locator(h1('Вход'))).toBeVisible();
  await expect(page.locator('#boot-fallback')).toHaveCount(0);
});
