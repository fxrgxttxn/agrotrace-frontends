import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

export const DEMO_PASSWORD = 'agrotrace-demo';

export interface Watch {
  problems: string[];
  loginRetried?: boolean;
  navAt: number[];
  streamDropAt: number[];
}

const LOGIN_LIMITED = /^http 429 POST \/api\/v1\/auth\/login$/;

export const EXPECTED = [/^http 401 POST \/api\/v1\/auth\/refresh$/];

const STREAM_503 = 'http 503 GET /api/v1/events/stream';
const NAV_WINDOW_MS = 2000;

export function unexpected(w: Watch, alsoExpected: RegExp[] = []): string[] {
  const allowed = [...EXPECTED, ...alsoExpected, ...(w.loginRetried ? [LOGIN_LIMITED] : [])];
  const unexplained = w.streamDropAt
    .filter((at) => !w.navAt.some((n) => Math.abs(n - at) <= NAV_WINDOW_MS))
    .map(() => STREAM_503);
  return [...w.problems, ...unexplained].filter(
    (p) => !/^console: Failed to load resource/.test(p) && !allowed.some((re) => re.test(p)),
  );
}

export async function watch(page: Page): Promise<Watch> {
  const w: Watch = { problems: [], navAt: [], streamDropAt: [] };
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) w.navAt.push(Date.now());
  });
  page.on('console', (m) => {
    if (m.type() === 'error') w.problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => w.problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const line = `http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`;
    if (line === STREAM_503) w.streamDropAt.push(Date.now());
    else w.problems.push(line);
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

export async function signOut(page: Page): Promise<void> {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
}

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

export async function mockMail(page: Page, to: string, kind: 'invite' | 'passwordReset'): Promise<string> {
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

export async function mockApi(
  page: Page,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
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

export function randomInn(): string {
  const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const d = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const control = (w.reduce((s, x, i) => s + x * d[i]!, 0) % 11) % 10;
  return [...d, control].join('');
}

export const freshEmail = (what: string) =>
  `e2e-react-${what}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@agrotrace.test`;

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
