import { expect, type Page } from '@playwright/test';

export const PRODUCTION = { baseURL: 'http://angular-express.localhost', serviceWorkers: 'block' as const };

export const DEMO_PASSWORD = 'agrotrace-demo';

export interface Watch {
  problems: string[];
}

export const EXPECTED = [/^http 401 POST \/api\/v1\/auth\/refresh$/];

export async function watch(page: Page): Promise<Watch> {
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

export function unexpected(w: Watch, also: RegExp[] = []): string[] {
  return w.problems.filter(
    (p) => !/^console: Failed to load resource/.test(p) && ![...EXPECTED, ...also].some((re) => re.test(p)),
  );
}

export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

export async function signIn(page: Page, email: string, next?: string): Promise<void> {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((u) => u.pathname !== '/login', { timeout: 20000 });
  await expect(page.locator('.at-shell')).toBeVisible();
}

export async function focusStaysIn(page: Page, selector: string, times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate((sel) => {
      const a = document.activeElement;
      return !a || a === document.body || Boolean(document.querySelector(sel)?.contains(a));
    }, selector);
    const where = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160) ?? '');
    expect(inside, `Tab ${i + 1} left ${selector}: ${where}`).toBe(true);
  }
}

export async function shots(page: Page, dir: string, name: string): Promise<void> {
  for (const width of [360, 1280])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.evaluate(() => document.fonts.ready);
      expect(await horizontalOverflow(page), `${name} ${width}`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `${dir}/${name}-${width}-${theme}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.setViewportSize({ width: 1280, height: 900 });
}
