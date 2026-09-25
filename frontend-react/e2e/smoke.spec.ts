import { expect, test, type Page } from '@playwright/test';

// Smoke check of the React build behind the gateway (its real CSP: `script-src 'self'`): the login screen renders
// with no console error and no CSP violation, 360 px has no horizontal scroll, the public entry renders, and — only
// when api-express is up on the shared stack — a demo user signs in, the role guard answers /403 and a reload restores
// the session from the refresh cookie.

const DEMO = { email: 'petrov@agrotrace.test', password: 'agrotrace-demo', org: 'КФХ Петров И.С.' };

interface Watch {
  problems: string[];
}

/** Answers that are expected, not defects: the start-up session restore of an anonymous visitor gets 401 from
 * POST /auth/refresh (httpOnly cookie — the page cannot know beforehand), and `GET /events/stream` is 404 while the
 * backend under test has no SSE yet (then the bell stays at 0; reported, not hidden: see `annotate`). */
const EXPECTED = [/^http 401 POST \/api\/v1\/auth\/refresh$/, /^http 404 GET \/api\/v1\/events\/stream$/];

/** Unexpected problems. Chromium's own «Failed to load resource» console line carries no URL; the `http` entry of the
 * same response does, so those console lines are judged through it. */
function unexpected(w: Watch): string[] {
  return w.problems.filter(
    (p) => !/^console: Failed to load resource/.test(p) && !EXPECTED.some((re) => re.test(p)),
  );
}

function annotate(w: Watch): void {
  if (w.problems.some((p) => EXPECTED[1]!.test(p)))
    test
      .info()
      .annotations.push({
        type: 'backend',
        description: 'GET /events/stream answered 404 (no SSE in the backend yet)',
      });
}

async function watch(page: Page): Promise<Watch> {
  const w: Watch = { problems: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') w.problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => w.problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400)
      w.problems.push(`http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __csp: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return w;
}

async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Through the browser (the request context would not use Chromium's host mapping). */
async function apiUp(page: Page): Promise<boolean> {
  await page.goto('/p/health-probe');
  return page.evaluate(async () => (await fetch('/api/v1/health/live')).status === 200);
}

test('gateway serves the build with its CSP', async ({ page }) => {
  const res = await page.goto('/login');
  expect(res?.status()).toBe(200);
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(await page.locator('script:not([src])').count()).toBe(0);
});

test('/login renders without console errors or CSP violations, no horizontal scroll at 360 px', async ({
  page,
}) => {
  const w = await watch(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Пароль')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // the sprite is in the document and the design system CSS applies
  expect(await page.locator('body > svg#at-sprite symbol#i-bell').count()).toBe(1);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
  await page.screenshot({ path: 'test-results/shots/login-360-light.png', fullPage: true });
});

test('a cabinet route without a session goes to /login?next=', async ({ page }) => {
  await page.goto('/batches?status=Approved');
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('next')).toBe('/batches?status=Approved');
});

test('the public entry renders /p/:publicCode without cabinet code', async ({ page }) => {
  const w = await watch(page);
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname);
  });
  await page.goto('/p/AT-2026-000123');
  await expect(page.getByRole('heading', { level: 1, name: 'Партия' })).toBeVisible();
  expect(scripts.some((s) => /\/assets\/(auth|home|fields|batches|admin)-/.test(s))).toBe(false);
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test.describe('with the live API', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await apiUp(page)),
      'api-express is not up on the shared stack (./at up express) — login steps skipped',
    );
  });

  test('a demo user signs in, sees the shell, meets the role guard and keeps the session on reload', async ({
    page,
  }) => {
    const w = await watch(page);
    await page.goto('/login?next=%2Fbatches');
    await page.getByLabel('Email').fill(DEMO.email);
    await page.getByLabel('Пароль').fill(DEMO.password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
    await expect(page).toHaveURL(/\/batches$/);
    await expect(page.locator('.at-topbar__org-name')).toHaveText(DEMO.org);
    await expect(page.locator('.at-sidebar').getByRole('link', { name: 'Поля' })).toBeVisible();

    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { level: 1, name: 'Нет доступа' })).toBeVisible();
    await expect(page).toHaveURL(/\/403$/);

    await page.goto('/fields');
    await expect(page.getByRole('heading', { level: 1, name: 'Поля' })).toBeVisible();
    expect(await cspViolations(page)).toEqual([]);
    annotate(w);
    expect(unexpected(w)).toEqual([]);

    await page.goto('/profile');
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  });

  test('shell screenshots at 360 / 900 / 1280 in both themes (for comparison with the showcase)', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(DEMO.email);
    await page.getByLabel('Пароль').fill(DEMO.password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Панель' })).toBeVisible();
    for (const width of [360, 900, 1280])
      for (const scheme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: width === 360 ? 780 : 800 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/batches');
        await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(await horizontalOverflow(page), `${width} ${scheme}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `test-results/shots/shell-${width}-${scheme}.png` });
        if (width === 360) {
          await page.getByRole('button', { name: 'Ещё' }).click();
          await expect(page.locator('#more-menu')).toBeVisible();
          await page.waitForTimeout(400); // the sheet's opening transition
          await page.screenshot({ path: `test-results/shots/more-${scheme}.png` });
          await page.keyboard.press('Escape');
        }
      }
  });
});
