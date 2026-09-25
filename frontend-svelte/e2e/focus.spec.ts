import { expect, test, type Page } from '@playwright/test';
import { ANONYMOUS, mockApi } from './contract';

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
