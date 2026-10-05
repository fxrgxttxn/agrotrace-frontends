import { expect, test, type Page } from '@playwright/test';
import { entryFiles, nodeFile } from './chunks';
import { ANONYMOUS, mockApi } from './contract';
import { cspViolations, watch } from './helpers';

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} ${el.textContent?.trim() ?? ''}` : '';
  });

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
  await expect(h1(page, 'AT-2026-000123')).toBeVisible();
  await follow(page, '/batches/2');
  await expect(page).toHaveURL(/\/batches\/2$/);
  await expect(h1(page, 'AT-2026-000123')).toBeFocused();
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
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
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

test('while a page chunk loads, the target section is current and the content is busy; then F4', async ({
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
  const urlWhileLoading = new URL(page.url()).pathname;
  test.info().annotations.push({ type: 'URL while loading', description: urlWhileLoading });
  console.log(`URL while the chunk loads: ${urlWhileLoading}`);
  release();
  await expect(h1(page, 'Поля')).toBeFocused();
  await expect(page).toHaveURL(/\/fields$/);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
});

test('«Повторить» → loading → «Сервис недоступен» again puts the focus back on «Повторить»', async ({
  page,
  context,
}) => {
  await mockApi(context, { refreshToken: { abort: true, times: 2 } });
  await page.goto('/fields');
  await expect(h1(page, 'Сервис недоступен')).toBeVisible();
  expect(await active(page)).toMatch(/^body/);
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(h1(page, 'Сервис недоступен')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeFocused();
  await page.getByRole('button', { name: 'Повторить' }).press('Enter');
  await expect(h1(page, 'Поля')).toBeVisible();
});

test('`next` never carries the #fragment', async ({ page, context }) => {
  await mockApi(context, ANONYMOUS);
  await page.goto('/batches?status=Approved#top');
  await expect(h1(page, 'Вход')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('next')).toBe('/batches?status=Approved');
});

const FIELDS_CHUNK = nodeFile('src/routes/(app)/(cabinet)/fields/+page.svelte');

test('a page chunk that fails once — one full load of the target, then the page; history as a normal visit', async ({
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
  expect(documents).toEqual(['/batches', '/fields']);
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack();
  await expect(h1(page, 'Партии')).toBeVisible();
  await expect(page).toHaveURL(/\/batches$/);
});

test('a page chunk that keeps failing — one full load, then «Не удалось загрузить страницу» in the shell', async ({
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
  expect(documents).toEqual(['/batches', '/fields']);
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await main.getByRole('button', { name: 'Повторить' }).click();
  await expect(main.locator('.at-empty__text')).toHaveText('Не удалось загрузить страницу.');
  expect(documents).toEqual(['/batches', '/fields', '/fields']);
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await page.goBack();
  await expect(h1(page, 'Партии')).toBeVisible();
  expect(w.problems.filter((p) => /pageerror/.test(p))).toEqual([]);
});

test('entering the shell from /login?next= with a slow chunk shows the shell, the section and the loading page', async ({
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

async function heldChunk(page: Page, context: import('@playwright/test').BrowserContext) {
  let settle: (ok: boolean) => void = () => {};
  const decided = new Promise<boolean>((r) => (settle = r));
  const documents: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
  });
  await context.route(`**${FIELDS_CHUNK}`, async (route) =>
    (await decided) ? route.continue() : route.abort('failed'),
  );
  return { documents, fail: () => settle(false), pass: () => settle(true) };
}

test('a failing load superseded by another click never reloads the page the user is on', async ({
  page,
  context,
}) => {
  await mockApi(context);
  const chunk = await heldChunk(page, context);
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  const before = await page.evaluate(() => history.length);
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await page.waitForTimeout(150);
  await page.locator('.at-sidebar').getByRole('link', { name: 'Накладные' }).click();
  await expect(h1(page, 'Накладные')).toBeVisible();
  chunk.fail();
  await page.waitForTimeout(800);
  await expect(page).toHaveURL(/\/waybills$/);
  await expect(h1(page, 'Накладные')).toBeVisible();
  expect(chunk.documents).toEqual(['/batches']);
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  expect(await page.evaluate(() => sessionStorage.getItem('agrotrace-chunk-reload'))).toBeNull();
});

test('Back during a failing load never reloads the page the user returns to', async ({ page, context }) => {
  await mockApi(context);
  const chunk = await heldChunk(page, context);
  await page.goto('/batches');
  await page.locator('.at-sidebar').getByRole('link', { name: 'Накладные' }).click();
  await expect(h1(page, 'Накладные')).toBeFocused();
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await page.waitForTimeout(150);
  await page.goBack();
  await expect(page).toHaveURL(/\/batches$/);
  chunk.fail();
  await page.waitForTimeout(800);
  await expect(page).toHaveURL(/\/batches$/);
  await expect(h1(page, 'Партии')).toBeVisible();
  expect(chunk.documents).toEqual(['/batches']);
});

test('after a failure the error state is not kept — the next navigation retries (fresh document)', async ({
  page,
  context,
}) => {
  await mockApi(context);
  const documents: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
  });
  await context.route(`**${FIELDS_CHUNK}`, (route) => route.abort('failed'));
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.locator('.at-shell__main .at-empty__text')).toHaveText('Не удалось загрузить страницу.');
  expect(documents).toEqual(['/batches', '/fields']);
  await context.unroute(`**${FIELDS_CHUNK}`);
  await page.locator('.at-sidebar').getByRole('link', { name: 'Накладные' }).click();
  await expect(h1(page, 'Накладные')).toBeVisible();
  expect(documents).toEqual(['/batches', '/fields', '/waybills']);
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(h1(page, 'Поля')).toBeFocused();
  expect(documents).toEqual(['/batches', '/fields', '/waybills']);
  expect(await page.evaluate(() => sessionStorage.getItem('agrotrace-chunk-reload'))).toBeNull();
});

test('a failing start-up chunk (public page) — one reload, then a static message with «Повторить»', async ({
  page,
  context,
}) => {
  await mockApi(context);
  const documents: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
  });
  const start = entryFiles.find((f) => /\/entry\/start\./.test(f))!;
  await context.route(`**${start}`, (route) => route.abort('failed'));
  await page.goto('/p/AT-2026-000123');
  const retry = await staticScreen(page);
  expect(documents).toEqual(['/p/AT-2026-000123', '/p/AT-2026-000123']);
  await context.unroute(`**${start}`);
  await retry.click();
  await expect(h1(page, 'Пшеница озимая')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('agrotrace-chunk-reload'))).toBeNull();
});

const ROOT_CHUNK = nodeFile('src/routes/+layout.svelte');
const KIT_ROOT_FAILURE = /^pageerror: Failed to fetch dynamically imported module: .*\/nodes\/0\./;

async function staticScreen(page: Page, timeout = 5000) {
  const box = page.locator('#at-load-failed');
  await expect(box).toBeVisible({ timeout });
  await expect(box.locator('main.at-page > article.at-card > .at-empty > p.at-empty__text')).toHaveText(
    'Не удалось загрузить страницу.',
  );
  const retry = box.getByRole('link', { name: 'Повторить' });
  await expect(retry).toHaveAttribute('href', '');
  await expect(retry).toHaveAttribute('data-variant', 'primary');
  await expect
    .poll(() => retry.evaluate((el) => getComputedStyle(el).backgroundColor), { timeout })
    .not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.locator('body')).not.toContainText(/500|chunk|Internal Error/);
  return retry;
}

for (const path of ['/batches', '/p/AT-2026-000123'])
  test(`the root layout chunk fails on ${path} — one reload, then the static screen (never the raw error page)`, async ({
    page,
    context,
  }) => {
    await mockApi(context);
    const w = await watch(page);
    await context.addInitScript(() => localStorage.setItem('agrotrace-theme', 'dark'));
    const documents: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
    });
    await context.route(`**${ROOT_CHUNK}`, (route) => route.abort('failed'));
    await page.goto(path);
    await expect.poll(() => documents.length).toBe(2);
    const retry = await staticScreen(page);
    expect(documents).toEqual([path, path]);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => sessionStorage.getItem('agrotrace-focus-title'))).toBeNull();
    expect(await cspViolations(page)).toEqual([]);
    expect(w.problems.filter((p) => p.startsWith('pageerror') && !KIT_ROOT_FAILURE.test(p))).toEqual([]);
    await context.unroute(`**${ROOT_CHUNK}`);
    await retry.click();
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page.locator('#at-load-failed')).toHaveCount(0);
    expect(await cspViolations(page)).toEqual([]);
  });

test('S1 minors: after a failure, a link that replaces its entry stays a replacement as a full document load', async ({
  page,
  context,
}) => {
  await mockApi(context);
  const documents: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
  });
  await context.route(`**${FIELDS_CHUNK}`, (route) => route.abort('failed'));
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.locator('.at-shell__main .at-empty__text')).toHaveText('Не удалось загрузить страницу.');
  const length = await page.evaluate(() => history.length);
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = '/waybills';
    a.id = 'probe';
    a.textContent = 'probe';
    a.setAttribute('data-sveltekit-replacestate', '');
    document.querySelector('.at-shell__main')!.append(a);
  });
  await page.locator('#probe').click();
  await expect(h1(page, 'Накладные')).toBeVisible();
  expect(documents).toEqual(['/batches', '/fields', '/waybills']);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await expect(h1(page, 'Партии')).toBeVisible();
});

test('S1 minors: the focus flag of a reload is spent by the first page shown, even one without a title', async ({
  page,
  context,
}) => {
  await mockApi(context);
  await page.goto('/p/AT-2026-000123');
  await expect(h1(page, 'Пшеница озимая')).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('agrotrace-focus-title', '1'));
  await page.reload();
  await expect(h1(page, 'Пшеница озимая')).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('agrotrace-focus-title'))).toBeNull();
});

test('the entry script itself cannot load — index.html shows its static screen after 10 s', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await mockApi(context);
  const w = await watch(page);
  await context.route('**/assets/immutable/entry/boot.*.js', (route) => route.abort('failed'));
  await page.goto('/batches');
  await page.waitForTimeout(2000);
  await expect(page.locator('#at-load-failed')).toBeHidden();
  const retry = await staticScreen(page, 15000);
  expect(await cspViolations(page)).toEqual([]);
  expect(w.problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
  await context.unroute('**/assets/immutable/entry/boot.*.js');
  await retry.click();
  await expect(h1(page, 'Партии')).toBeVisible();
  await expect(page.locator('#at-load-failed')).toHaveCount(0);
  expect(await cspViolations(page)).toEqual([]);
});

test('round 3: after the automatic reload the page title has the focus and the #fragment is kept', async ({
  page,
  context,
}) => {
  await mockApi(context);
  let failures = 1;
  await context.route(`**${FIELDS_CHUNK}`, (route) =>
    failures-- > 0 ? route.abort('failed') : route.continue(),
  );
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await follow(page, '/fields#top');
  await expect(h1(page, 'Поля')).toBeFocused();
  expect(new URL(page.url()).hash).toBe('#top');
});

test('round 3: on the failure page its own section link retries in a fresh document', async ({
  page,
  context,
}) => {
  await mockApi(context);
  const documents: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
  });
  await context.route(`**${FIELDS_CHUNK}`, (route) => route.abort('failed'));
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.locator('.at-shell__main .at-empty__text')).toHaveText('Не удалось загрузить страницу.');
  await context.unroute(`**${FIELDS_CHUNK}`);
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(h1(page, 'Поля')).toBeFocused();
  expect(documents).toEqual(['/batches', '/fields', '/fields']);
});

test('round 3: focus inside main does not fall to <body> while the next page loads', async ({
  page,
  context,
}) => {
  await mockApi(context);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await context.route(`**${FIELDS_CHUNK}`, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await follow(page, '/fields');
  await expect(page.locator('.at-shell__main > .at-page[aria-busy="true"]')).toBeVisible();
  await expect(page.locator('main#main')).toBeFocused();
  release();
  await expect(h1(page, 'Поля')).toBeFocused();
});

test('without sessionStorage a failing page chunk still gets its one reload (the mark in the history state)', async ({
  page,
  context,
}) => {
  await mockApi(context);
  await context.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  });
  const documents: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
  });
  let failures = 1;
  await context.route(`**${FIELDS_CHUNK}`, (route) =>
    failures-- > 0 ? route.abort('failed') : route.continue(),
  );
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(h1(page, 'Поля')).toBeVisible();
  expect(documents).toEqual(['/batches', '/fields']);
});

test('without sessionStorage a chunk that keeps failing reloads once, never loops', async ({
  page,
  context,
}) => {
  await mockApi(context);
  await context.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  });
  const documents: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') documents.push(new URL(r.url()).pathname);
  });
  await context.route(`**${FIELDS_CHUNK}`, (route) => route.abort('failed'));
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  await page.locator('.at-sidebar').getByRole('link', { name: 'Поля' }).click();
  await expect(page.locator('.at-shell__main .at-empty__text')).toHaveText('Не удалось загрузить страницу.');
  await page.waitForTimeout(1000);
  expect(documents).toEqual(['/batches', '/fields']);
  expect(await page.evaluate(() => window.name)).toBe('');
});

test('a query-only change made while nothing has the focus leaves it on the document (React parity)', async ({
  page,
  context,
}) => {
  await mockApi(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/batches');
  await expect(h1(page, 'Партии')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.getByLabel('Статус').selectOption({ index: 1 });
  await expect(page).toHaveURL(/status=/);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(/\/batches$/);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});
