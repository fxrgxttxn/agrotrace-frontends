import { expect, test, type Page } from '@playwright/test';
import { nodeFile } from './chunks';
import { ANONYMOUS, mockApi } from './contract';
import { watch } from './helpers';

// Focus, history and redirects with the REAL SvelteKit router of the build (rulings F4, FM7; README «Фокус при смене
// маршрута»): every client-side pathname change except the first load focuses the new page's h1 — redirects included;
// query-only navigation keeps focus where it was; a pick in «Ещё» keeps focus on «Ещё»; when a 429 wait ends, the
// retry button takes the focus. Plus the role guard after a successful retry.

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} ${el.textContent?.trim() ?? ''}` : '';
  });

/** An in-app link to `href` inside the page content, focused and clicked like a user would. */
async function follow(page: Page, href: string): Promise<void> {
  await page.evaluate((to) => {
    const a = document.createElement('a');
    a.href = to;
    a.id = 'probe';
    a.textContent = 'probe';
    document.querySelector('main .at-page')!.append(a);
  }, href);
  await page.locator('#probe').focus();
  await page.keyboard.press('Enter');
}

test('first load leaves focus on the document; the title is focusable', async ({ page, context }) => {
  await mockApi(context);
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await expect(h1(page, 'Партии')).toHaveAttribute('tabindex', '-1');
  expect(await active(page)).toMatch(/^body/);
});

test('a start-up redirect counts as the first load', async ({ page, context }) => {
  await mockApi(context, ANONYMOUS);
  await page.goto('/batches');
  await expect(h1(page, 'Вход')).toBeVisible();
  expect(await active(page)).toMatch(/^body/);
});

test('a link, back and forward move focus to the new title', async ({ page, context }) => {
  await mockApi(context);
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(h1(page, 'Поля')).toBeFocused();
  await page.goBack();
  await expect(h1(page, 'Партии')).toBeFocused();
  await page.goForward();
  await expect(h1(page, 'Поля')).toBeFocused();
});

test('a parameter change on the same route moves focus to the title', async ({ page, context }) => {
  await mockApi(context);
  await page.goto('/batches/1');
  await expect(h1(page, 'Партия')).toBeVisible();
  await follow(page, '/batches/2');
  await expect(page).toHaveURL(/\/batches\/2$/);
  await expect(h1(page, 'Партия')).toBeFocused();
});

test('a query-only navigation keeps focus where it was', async ({ page, context }) => {
  await mockApi(context);
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await follow(page, '/batches?page=2');
  await expect(page).toHaveURL(/\?page=2$/);
  await expect(page.locator('#probe')).toBeFocused();
});

test('a redirect during client navigation focuses the page it lands on; history holds the final URL only', async ({
  page,
  context,
}) => {
  await mockApi(context);
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await follow(page, '/admin/users');
  await expect(page).toHaveURL(/\/403$/);
  await expect(h1(page, 'Нет доступа')).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/\/batches$/);
  await expect(h1(page, 'Партии')).toBeFocused();
});

test('after login the target page title has the focus', async ({ page, context }) => {
  await mockApi(context, ANONYMOUS);
  await page.goto('/login?next=%2Ffields');
  await expect(h1(page, 'Вход')).toBeVisible();
  await page.getByLabel('Email').fill('petrov@kfh-petrov.ru');
  await page.getByLabel('Пароль').fill('x');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(h1(page, 'Поля')).toBeFocused();
});

test('a pick in «Ещё» (360 px) keeps focus on «Ещё»; the next navigation moves it to the title again', async ({
  page,
  context,
}) => {
  await mockApi(context);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  const more = page.getByRole('button', { name: 'Ещё' });
  await more.click();
  await expect(page.locator('#more-title')).toBeFocused();
  await page.locator('#more-menu').getByRole('link', { name: 'Профиль' }).click();
  await expect(h1(page, 'Профиль')).toBeVisible();
  await expect(page.locator('#more-menu')).not.toHaveAttribute('open');
  await expect(more).toBeFocused();
  await page.locator('.at-bottom-nav').getByRole('link', { name: 'Поля' }).click();
  await expect(h1(page, 'Поля')).toBeFocused();
});

test('keyboard pick in «Ещё» keeps focus on «Ещё» too', async ({ page, context }) => {
  await mockApi(context);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/batches');
  const more = page.getByRole('button', { name: 'Ещё' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#more-title')).toBeFocused();
  await page.keyboard.press('Tab'); // the close button
  await page.keyboard.press('Tab'); // the first item
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(/\/batches$/);
  await expect(more).toBeFocused();
});

test('when the 429 wait ends, «Повторить» takes the focus', async ({ page, context }) => {
  await mockApi(context, {
    getMe: { status: 429, once: true, headers: { 'Retry-After': '2' } },
  });
  await page.goto('/fields');
  await expect(h1(page, 'Сервис недоступен')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Повторить через \d+ с$/ })).toBeDisabled();
  const retry = page.getByRole('button', { name: 'Повторить' });
  await expect(retry).toBeEnabled({ timeout: 5000 });
  await expect(retry).toBeFocused();
  await retry.press('Enter');
  await expect(h1(page, 'Поля')).toBeVisible();
});

test('a retry that restores a session of another role goes to /403, never shows the page', async ({
  page,
  context,
}) => {
  await mockApi(context, { refreshToken: { abort: true, once: true } });
  const seen: string[] = [];
  await page.exposeFunction('__h1', (t: string) => seen.push(t));
  await page.addInitScript(() => {
    new MutationObserver(() => {
      for (const h of document.querySelectorAll('h1'))
        (window as unknown as { __h1: (t: string) => void }).__h1(h.textContent ?? '');
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.goto('/admin/users');
  await expect(h1(page, 'Сервис недоступен')).toBeVisible();
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(h1(page, 'Нет доступа')).toBeVisible();
  await expect(page).toHaveURL(/\/403$/);
  expect(seen).not.toContain('Пользователи');
});

// ── Review round 2 and ruling FM10 ─────────────────────────────────────────────────────────────────────────────────

test('back and forward across a query-only change keep focus where it was', async ({ page, context }) => {
  await mockApi(context);
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await follow(page, '/batches?page=2');
  await expect(page).toHaveURL(/\?page=2$/);
  await expect(page.locator('#probe')).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/\/batches$/);
  await expect(page.locator('#probe')).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(/\?page=2$/);
  await expect(page.locator('#probe')).toBeFocused();
});

test('picking the current page in «Ещё» adds no history entry and keeps focus on «Ещё»', async ({
  page,
  context,
}) => {
  await mockApi(context);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/profile');
  await expect(h1(page, 'Профиль')).toBeVisible();
  const before = await page.evaluate(() => history.length);
  const more = page.getByRole('button', { name: 'Ещё' });
  await more.click();
  await page.locator('#more-menu').getByRole('link', { name: 'Профиль' }).click();
  await expect(page.locator('#more-menu')).not.toHaveAttribute('open');
  await expect(more).toBeFocused();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => history.length)).toBe(before);
  await expect(more).toBeFocused();
});

test('Back while «Ещё» is open closes the sheet and focuses the page it returns to', async ({
  page,
  context,
}) => {
  await mockApi(context);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/batches');
  await page.locator('.at-bottom-nav').getByRole('link', { name: 'Поля' }).click();
  await expect(h1(page, 'Поля')).toBeFocused();
  await page.getByRole('button', { name: 'Ещё' }).click();
  await expect(page.locator('#more-title')).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/\/batches$/);
  await expect(page.locator('#more-menu')).not.toHaveAttribute('open');
  await expect(h1(page, 'Партии')).toBeFocused();
});

test('FM10: while a page chunk loads, the target section is current and the content is busy; then F4', async ({
  page,
  context,
}) => {
  await mockApi(context);
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/assets/immutable/nodes/**', async (route) => {
    await held;
    await route.continue();
  });
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.locator('.at-shell__main > .at-page[aria-busy="true"]')).toBeVisible();
  await expect(page.locator('.at-sidebar a[href="/fields"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.at-sidebar a[href="/batches"]')).not.toHaveAttribute('aria-current', 'page');
  // SvelteKit commits the URL when the navigation completes (see the task report: FM10 URL note).
  const urlWhileLoading = new URL(page.url()).pathname;
  test.info().annotations.push({ type: 'FM10 URL while loading', description: urlWhileLoading });
  console.log(`FM10 URL while the chunk loads: ${urlWhileLoading}`);
  release();
  await expect(h1(page, 'Поля')).toBeFocused();
  await expect(page).toHaveURL(/\/fields$/);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
});

test('FM10: «Повторить» → loading → «Сервис недоступен» again puts the focus back on «Повторить»', async ({
  page,
  context,
}) => {
  await mockApi(context, { refreshToken: { abort: true, times: 2 } });
  await page.goto('/fields');
  await expect(h1(page, 'Сервис недоступен')).toBeVisible();
  expect(await active(page)).toMatch(/^body/); // first load: nothing moved
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(h1(page, 'Сервис недоступен')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeFocused();
  await page.getByRole('button', { name: 'Повторить' }).press('Enter');
  await expect(h1(page, 'Поля')).toBeVisible();
});

test('FM10: `next` never carries the #fragment', async ({ page, context }) => {
  await mockApi(context, ANONYMOUS);
  await page.goto('/batches?status=Approved#top');
  await expect(h1(page, 'Вход')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('next')).toBe('/batches?status=Approved');
});

// ── Ruling FM11: page-chunk failures and entering the shell ───────────────────────────────────────────────────────

const FIELDS_CHUNK = nodeFile('src/routes/(app)/(cabinet)/fields/+page.svelte');

test('FM11: a page chunk that fails once — one full load of the target, then the page; history as a normal visit', async ({
  page,
  context,
}) => {
  await mockApi(context);
  let failures = 1;
  const documents: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
  });
  await context.route(`**${FIELDS_CHUNK}`, (route) =>
    failures-- > 0 ? route.abort('failed') : route.continue(),
  );
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  const before = await page.evaluate(() => history.length);
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(h1(page, 'Поля')).toBeVisible();
  await expect(page).toHaveURL(/\/fields$/);
  expect(documents).toEqual(['/batches', '/fields']); // exactly one full load, of the target
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack();
  await expect(h1(page, 'Партии')).toBeVisible();
  await expect(page).toHaveURL(/\/batches$/);
});

test('FM11: a page chunk that keeps failing — one full load, then «Не удалось загрузить страницу» in the shell', async ({
  page,
  context,
}) => {
  const w = await watch(page);
  await mockApi(context);
  const documents: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
  });
  await context.route(`**${FIELDS_CHUNK}`, (route) => route.abort('failed'));
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  const before = await page.evaluate(() => history.length);
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  const main = page.locator('main.at-shell__main');
  await expect(main.locator('.at-empty__text')).toHaveText('Не удалось загрузить страницу.');
  await expect(h1(page, 'Поля')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Повторить' })).toBeVisible();
  await expect(page.locator('.at-sidebar a[href="/fields"]')).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/\/fields$/);
  await expect(page.locator('body')).not.toContainText(/Internal Error|500|Failed to fetch/);
  expect(documents).toEqual(['/batches', '/fields']); // no reload loop
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  // «Повторить» reloads the page (still failing here: the same state, still no loop)
  await main.getByRole('button', { name: 'Повторить' }).click();
  await expect(main.locator('.at-empty__text')).toHaveText('Не удалось загрузить страницу.');
  expect(documents).toEqual(['/batches', '/fields', '/fields']);
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack();
  await expect(h1(page, 'Партии')).toBeVisible();
  expect(w.problems.filter((p) => /pageerror/.test(p))).toEqual([]);
});

test('FM11: entering the shell from /login?next= with a slow chunk shows the shell, the section and the loading page', async ({
  page,
  context,
}) => {
  await mockApi(context, ANONYMOUS);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await context.route(`**${FIELDS_CHUNK}`, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/login?next=%2Ffields');
  await expect(h1(page, 'Вход')).toBeVisible();
  await page.getByLabel('Email').fill('petrov@kfh-petrov.ru');
  await page.getByLabel('Пароль').fill('x');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.locator('.at-shell .at-shell__main > .at-page[aria-busy="true"]')).toBeVisible();
  await expect(page.locator('.at-sidebar a[href="/fields"]')).toHaveAttribute('aria-current', 'page');
  await expect(h1(page, 'Вход')).toHaveCount(0);
  release();
  await expect(h1(page, 'Поля')).toBeFocused();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
});
