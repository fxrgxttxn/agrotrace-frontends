import { expect, type Page } from '@playwright/test';

export const DEMO_PASSWORD = 'agrotrace-demo';

export interface Watch {
  problems: string[];
  loginRetried?: boolean;
}

const LOGIN_LIMITED = /^http 429 POST \/api\/v1\/auth\/login$/;

const SVELTE_SELECT_PROBE =
  /^console: A span tag was parsed inside of a <select> which was not inserted into the document/;
const EXPECTED = [
  /^http 401 POST \/api\/v1\/auth\/refresh$/,
  /^http 503 GET \/api\/v1\/events\/stream$/,
  SVELTE_SELECT_PROBE,
];

export function unexpected(w: Watch, alsoExpected: RegExp[] = []): string[] {
  const allowed = [...EXPECTED, ...alsoExpected, ...(w.loginRetried ? [LOGIN_LIMITED] : [])];
  return w.problems.filter(
    (p) => !/^console: Failed to load resource/.test(p) && !allowed.some((re) => re.test(p)),
  );
}

export async function watch(page: Page): Promise<Watch> {
  const w: Watch = { problems: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') w.problems.push(`console: ${m.text()}`);
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

export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

export async function signIn(page: Page, email: string, password: string, w?: Watch): Promise<void> {
  if (!/\/login/.test(page.url())) await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  const never = () => new Promise<never>(() => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole('button', { name: 'Войти' }).click();
    const outcome = await Promise.race([
      page.waitForURL((u) => u.pathname !== '/login', { timeout: 15000 }).then(() => 'moved' as const, never),
      page
        .getByRole('button', { name: /^Повторить через/ })
        .waitFor({ timeout: 15000 })
        .then(() => 'limited' as const, never),
      page
        .locator('.at-toast-region[role="alert"] .at-toast')
        .waitFor({ timeout: 15000 })
        .then(() => 'error' as const, never),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 16000)),
    ]);
    if (outcome === 'moved' || outcome === 'error') return;
    if (outcome === 'timeout')
      throw new Error(`signIn(${email}): no navigation, message or limit within 16 s`);
    if (w) w.loginRetried = true;
    if (attempt === 2) break;
    await expect(page.getByRole('button', { name: 'Войти' })).toBeEnabled({ timeout: 70000 });
  }
  throw new Error(`signIn(${email}): the login limit still answered 429 after 3 attempts`);
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
