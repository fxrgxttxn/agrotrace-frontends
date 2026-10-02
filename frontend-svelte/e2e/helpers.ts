import { expect, type Page } from '@playwright/test';

// Console, page errors, failed responses and CSP violations of a page (the same watch as the React smoke spec), and
// the pieces of the mock-stand specs (ruling FM23): the demo password, the retrying sign-in, the full-screen focus
// check — as the React e2e helpers.

export const DEMO_PASSWORD = 'agrotrace-demo';

export interface Watch {
  problems: string[];
  /** `signIn` met the login-ip limit (429) and waited it out: that answer is expected then. */
  loginRetried?: boolean;
}

const LOGIN_LIMITED = /^http 429 POST \/api\/v1\/auth\/login$/;

/** Answers that are expected, not defects: the anonymous start-up refresh (401); on the mock stand, an event-stream
 * reconnect of a document that is being left by a full page load (the MSW worker no longer serves a closing client,
 * so that request reaches the gateway, which answers 503; the new document opens its own stream through the worker). */
/** Svelte 5 runtime: its one-time feature probe for rich `<option>` content (customizable-select.js, run when a
 * `<select>` renders snippet children — every `Select`) parses `<option><span>` in a detached `<select>`; Chromium
 * warns about that probe. It is not markup of the page (since S3 every list filter is a `Select`). */
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

/** The login form: submits and, if the login-ip limit answers 429 (20 per 60 s, rate-limits.json — the mock counts it
 * too), waits out the countdown and submits again. Pass the page's Watch so that 429 is not a defect.
 * Returns once the page left /login or showed an error message; throws when nothing happened within 16 s or the limit
 * still answered after the last attempt. */
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

/** Tab `times` times: the focus is only ever inside `selector` (a full-screen block, the rest inert) or out of the page. */
export async function focusStaysIn(page: Page, selector: string, times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate((sel) => {
      // Past the last control the focus leaves the document for the browser (body is active), as with a native modal
      // dialog; it must never land on the page behind the block.
      const a = document.activeElement;
      return !a || a === document.body || Boolean(document.querySelector(sel)?.contains(a));
    }, selector);
    const where = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160) ?? '');
    expect(inside, `Tab ${i + 1} left ${selector}: ${where}`).toBe(true);
  }
}
