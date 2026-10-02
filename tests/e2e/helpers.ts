import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Pieces shared by the parity specs: console / HTTP watch, sign-in through the login form (waiting out the login-ip
// limit), screenshots at 360 and 1280 px in both themes with the no-horizontal-scroll check.

export const DEMO_PASSWORD = 'agrotrace-demo';
const FRONT = process.env.FRONT ?? 'react';
const BACK = process.env.BACK ?? 'mock';

export interface Watch {
  problems: string[];
  loginRetried?: boolean;
  navAt: number[];
  streamDropAt: number[];
}

/** The anonymous start-up refresh (401) is an answer, not a defect. */
const EXPECTED = [/^http 401 POST \/api\/v1\/auth\/refresh$/];
const LOGIN_LIMITED = /^http 429 POST \/api\/v1\/auth\/login$/;
const STREAM_503 = 'http 503 GET /api/v1/events/stream';
/** Mock stand: a document being left may reconnect its event stream after the worker stopped serving it (503). */
const NAV_WINDOW_MS = 2000;

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
  return w;
}

/** Problems that are not explained: `alsoExpected` — answers the spec provokes on purpose. */
export function unexpected(w: Watch, alsoExpected: RegExp[] = []): string[] {
  const allowed = [...EXPECTED, ...alsoExpected, ...(w.loginRetried ? [LOGIN_LIMITED] : [])];
  const unexplained = w.streamDropAt
    .filter((at) => !w.navAt.some((n) => Math.abs(n - at) <= NAV_WINDOW_MS))
    .map(() => STREAM_503);
  return [...w.problems, ...unexplained].filter(
    (p) => !/^console: Failed to load resource/.test(p) && !allowed.some((re) => re.test(p)),
  );
}

/** The screen has settled: its h1 is shown and nothing is loading any more (aria-busy, FM10/FM24). */
export async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20000 });
}

/** Design-system markup axe flags although WCAG exempts it, recorded for the design-system backlog (README classes):
 * the unit suffix of a disabled input group (1.4.3: text of an inactive component; ink-muted on surface-sunk 4.2:1). */
const AXE_KNOWN = ['.at-input-group:has(:disabled) > .at-input-group__suffix'];

/** axe-core with the WCAG 2.0/2.1 A and AA rules: one line per violation (rule id and the nodes it found). */
export async function a11y(page: Page): Promise<string[]> {
  let axe = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  for (const selector of AXE_KNOWN) axe = axe.exclude(selector);
  const { violations } = await axe.analyze();
  return violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** The login form; a 429 of the login-ip limit is waited out (pass the Watch so it is not a defect). */
export async function signIn(page: Page, email: string, w?: Watch): Promise<void> {
  if (!/\/login/.test(page.url())) await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(DEMO_PASSWORD);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole('button', { name: 'Войти' }).click();
    const outcome = await Promise.race([
      page.waitForURL((u) => u.pathname !== '/login', { timeout: 15000 }).then(() => 'moved' as const),
      page
        .getByRole('button', { name: /^Повторить через/ })
        .waitFor({ timeout: 15000 })
        .then(() => 'limited' as const),
    ]).catch(() => 'timeout' as const);
    if (outcome === 'moved') return;
    if (outcome === 'timeout') throw new Error(`signIn(${email}): nothing happened within 15 s`);
    if (w) w.loginRetried = true;
    await expect(page.getByRole('button', { name: 'Войти' })).toBeEnabled({ timeout: 70000 });
  }
  throw new Error(`signIn(${email}): the login limit still answered 429 after 3 attempts`);
}

export async function signOut(page: Page): Promise<void> {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
}

/** Screenshots at 360 and 1280 px, light and dark, into test-results/shots/<front>-<back>/<dir>; each width is checked
 * for horizontal scrolling first. */
export async function shot(page: Page, dir: string, name: string): Promise<void> {
  for (const width of [360, 1280])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(150);
      expect(await horizontalOverflow(page), `${name} ${width} ${theme}`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `test-results/shots/${FRONT}-${BACK}/${dir}/${name}-${width}-${theme}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** A random INN with a valid FNS checksum (10 digits). */
export function randomInn(): string {
  const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const d = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const control = (w.reduce((s, x, i) => s + x * d[i]!, 0) % 11) % 10;
  return [...d, control].join('');
}

export const freshEmail = (what: string) =>
  `e2e-${what}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@agrotrace.test`;
