import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

// Shared pieces of the React e2e specs (through gateway-react, the live Express API of the shared stack).

export const DEMO_PASSWORD = 'agrotrace-demo';
/** Direct API (network agrotrace_at) for set-up steps the UI of this task does not cover (inviting a user). */
export const API = 'http://api-express:8000/api/v1';
/** Mailpit of the shared stack (letters of invite and password reset). */
export const MAILPIT = 'http://mailpit:8025/api/v1';

export interface Watch {
  problems: string[];
  /** `signIn` met the login-ip limit (429) and waited it out: that answer is expected then. */
  loginRetried?: boolean;
}

const LOGIN_LIMITED = /^http 429 POST \/api\/v1\/auth\/login$/;

/** Answers that are expected, not defects: the anonymous start-up refresh (401) and endpoints the Express backend does
 * not serve yet (404: SSE, notifications list, public regions) — see `annotateMissing`. */
export const EXPECTED = [
  /^http 401 POST \/api\/v1\/auth\/refresh$/,
  /^http 404 GET \/api\/v1\/events\/stream$/,
  /^http 404 GET \/api\/v1\/notifications$/,
  /^http 404 GET \/api\/v1\/public\/regions$/,
];

export function unexpected(w: Watch, alsoExpected: RegExp[] = []): string[] {
  const allowed = [...EXPECTED, ...alsoExpected, ...(w.loginRetried ? [LOGIN_LIMITED] : [])];
  return w.problems.filter(
    (p) => !/^console: Failed to load resource/.test(p) && !allowed.some((re) => re.test(p)),
  );
}

export function annotateMissing(w: Watch): void {
  for (const re of EXPECTED.slice(1))
    if (w.problems.some((p) => re.test(p)))
      test
        .info()
        .annotations.push({ type: 'backend', description: `${re.source} — not served by the backend yet` });
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

/** Through the browser (the request context would not use Chromium's host mapping). */
export async function apiUp(page: Page): Promise<boolean> {
  await page.goto('/p/health-probe');
  return page.evaluate(async () => (await fetch('/api/v1/health/live')).status === 200);
}

/** The login form: submits and, if the login-ip limit answers 429 (20 per 60 s for the one gateway-react IP on the
 * shared stack), waits out the countdown and submits again. Pass the page's Watch so that 429 is not a defect. */
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
    if (outcome !== 'limited') return;
    if (w) w.loginRetried = true;
    await expect(page.getByRole('button', { name: 'Войти' })).toBeEnabled({ timeout: 70000 });
  }
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

/** The newest letter to `to` whose text matches `link`; returns the first capture group (the token). */
export async function mailToken(request: APIRequestContext, to: string, link: RegExp): Promise<string> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const search = await request.get(`${MAILPIT}/search`, { params: { query: `to:"${to}"` } });
    if (search.ok()) {
      const { messages } = (await search.json()) as { messages: { ID: string }[] };
      for (const m of messages ?? []) {
        const msg = await request.get(`${MAILPIT}/message/${m.ID}`);
        const text = ((await msg.json()) as { Text?: string }).Text ?? '';
        const hit = link.exec(text);
        if (hit?.[1]) return hit[1];
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no letter to ${to} matching ${link}`);
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

/** `POST /auth/login` straight to the API for set-up steps; the login-ip limit (429) is waited out (Retry-After). */
export async function apiLogin(api: APIRequestContext, email: string, password: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await api.post(`${API}/auth/login`, { data: { email, password } });
    if (res.status() === 429) {
      const wait = Number(res.headers()['retry-after']) || 60;
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      continue;
    }
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()) as { accessToken: string }).accessToken;
  }
  throw new Error('login-ip limit did not clear');
}

// Express has no SSE yet: its 404 makes openEventStream refresh the token on every reconnect (1, 3, 7, 15 … s; F5/R63).
// A full page load that interrupts such a refresh loses the rotated cookie (the server already rotated it) and the
// next start-up refresh meets the R32 race answer — signed out. Specs about something else answer the stream with an
// empty event stream (the browser reconnects by itself, no refresh); smoke.spec.ts still reports the real 404 once.
export async function quietStream(context: BrowserContext): Promise<void> {
  await context.route('**/api/v1/events/stream**', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
      body: 'event: unread\ndata: {"count":0}\n\n',
    }),
  );
}
