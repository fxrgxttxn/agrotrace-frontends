import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

// Shared pieces of the React e2e specs. The mock stand (react-mock.localhost, ruling FM23) runs the in-browser backend of
// @agrotrace/mock-api: every test context has its own demo world (the mock keeps it in the origin's storage, shared by
// the context's tabs), the letters it "sends" are in `window.__agrotraceMock.mailbox` of the tab that made the request.

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
export const EXPECTED = [
  /^http 401 POST \/api\/v1\/auth\/refresh$/,
  /^http 503 GET \/api\/v1\/events\/stream$/,
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

export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** The login form: submits and, if the login-ip limit answers 429 (20 per 60 s, rate-limits.json — the mock counts it
 * too), waits out the countdown and submits again. Pass the page's Watch so that 429 is not a defect.
 * Returns once the page left /login or showed an error message; throws when nothing happened within 16 s or the limit
 * still answered after the last attempt (a silent return would only move the failure to a confusing later step). */
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

export async function signOut(page: Page): Promise<void> {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
}

/** RFC 6238 TOTP (SHA1, 6 digits, 30 s) of a base32 secret for time step `step`. */
export function totp(secretBase32: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

export const currentStep = () => Math.floor(Date.now() / 30000);

/** The newest letter of the mock (`kind`) to `to` in the mailbox of `page` (the tab whose request sent it; a full page
 * load starts a new mailbox) — its token. */
export async function mockMail(page: Page, to: string, kind: 'invite' | 'passwordReset'): Promise<string> {
  // polled with evaluate: waitForFunction needs eval, which the gateway CSP (script-src 'self') refuses
  let token: string | null = null;
  await expect
    .poll(
      async () =>
        (token = await page.evaluate(
          ([address, what]) => {
            const box = (
              window as unknown as {
                __agrotraceMock?: { mailbox: { kind: string; to: string; token: string }[] };
              }
            ).__agrotraceMock?.mailbox;
            return [...(box ?? [])].reverse().find((m) => m.to === address && m.kind === what)?.token ?? null;
          },
          [to, kind] as const,
        )),
      { timeout: 15000 },
    )
    .not.toBeNull();
  return token!;
}

/** The API of the mock from inside `page` (its own tab of the context's world): `fetch` with a bearer token. */
export async function mockApi(
  page: Page,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  // the service worker answers only once the page started the mock (`__agrotraceMock` is set when it is ready)
  await expect.poll(() => page.evaluate(() => '__agrotraceMock' in window)).toBe(true);
  return page.evaluate(
    async ({ path, init }) => {
      const res = await fetch(`/api/v1${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    { path, init },
  );
}

/** A random INN with a valid FNS checksum (10 digits, legal entity). */
export function randomInn(): string {
  const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const d = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const control = (w.reduce((s, x, i) => s + x * d[i]!, 0) % 11) % 10;
  return [...d, control].join('');
}

/** A unique address for this run (never a demo account: the shared data of Plan 1 stays as it is). */
export const freshEmail = (what: string) =>
  `e2e-react-${what}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@agrotrace.test`;

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
