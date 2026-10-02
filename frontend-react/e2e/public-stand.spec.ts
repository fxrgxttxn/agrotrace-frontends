import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';
import { cspViolations, horizontalOverflow, unexpected, watch } from './helpers';
import { stand } from './stand';

// The public QR page on the production build (Plan 2 Task 8) with the contract-example stand: the states a demo world
// does not have (blocked, service down, no network, rate limit), the failures of its own files (public chunk FM15,
// entry script FM18, ALTCHA worker), the gateway CSP with the worker running, and the performance check — LCP on a
// 360 px phone under Lighthouse's mobile throttling (4× CPU, 150 ms RTT, 1.6 Mbit/s).

const CODE = 'AT-2026-000123';
const SHOTS = 'test-results/shots/task8-stand';
type Json = Record<string, unknown>;

function challenge(number = 4242) {
  const salt = `e2e${Date.now().toString(16)}?expires=${Math.floor(Date.now() / 1000) + 600}`;
  const hash = createHash('sha256')
    .update(salt + number)
    .digest('hex');
  return { algorithm: 'SHA-256', challenge: hash, salt, signature: 'a'.repeat(64), maxnumber: 50000 };
}

const title = (page: Page) => page.getByRole('heading', { level: 1 });

async function shots(page: Page, name: string) {
  for (const width of [360, 1280])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.evaluate(() => document.fonts.ready);
      expect(await horizontalOverflow(page), `${name} ${width}`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `${SHOTS}/${name}-${width}-${theme}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
}

test('blocked and still-checked batches: the status and its one line; no raw error, no CSP violation', async ({
  page,
}) => {
  const w = await watch(page);
  await stand(page, {
    getPublicBatch: (_u: URL, body: unknown) => ({ ...(body as Json), safety: 'BLOCKED', status: 'Blocked' }),
  });
  await page.goto(`/p/${CODE}`);
  await expect(page.getByText('Продажа партии остановлена до решения инспектора.')).toBeVisible();
  await expect(page.getByText('Заблокирована', { exact: true })).toBeVisible();
  await shots(page, 'public-blocked');
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test('service down, then no network: what happened and «Повторить», which asks again', async ({ page }) => {
  await stand(page);
  let answer: 'down' | 'offline' | 'ok' = 'down';
  await page.route(`**/api/v1/public/batches/${CODE}`, (route: Route) =>
    answer === 'down'
      ? route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: '/problems/backend-unavailable',
            title: 'x',
            status: 503,
            code: 'BACKEND_UNAVAILABLE',
          }),
        })
      : answer === 'offline'
        ? route.abort('internetdisconnected')
        : route.fallback(),
  );
  await page.goto(`/p/${CODE}`);
  await expect(page.getByText('Сервис временно недоступен.')).toBeVisible();
  await shots(page, 'public-unavailable');
  answer = 'offline';
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByText('Нет связи с сервером — проверьте подключение.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeFocused();
  answer = 'ok';
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(title(page)).toHaveText('Пшеница озимая');
});

test('the complaint: ALTCHA solved in the worker under the gateway CSP; the 429 waits out Retry-After', async ({
  page,
}) => {
  const w = await watch(page);
  const sent: Json[] = [];
  await stand(page, { getCaptchaChallenge: () => challenge() });
  let limited = true;
  await page.route(`**/api/v1/public/batches/${CODE}/complaints`, async (route: Route) => {
    sent.push(route.request().postDataJSON() as Json);
    if (limited) {
      limited = false;
      return route.fulfill({
        status: 429,
        headers: { 'Retry-After': '3' },
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: '/problems/rate-limited',
          title: 'x',
          status: 429,
          code: 'RATE_LIMITED',
        }),
      });
    }
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b', createdAt: '2026-09-24T10:12:45Z' }),
    });
  });
  const response = await page.goto(`/p/${CODE}/complaint`);
  expect(response!.headers()['content-security-policy']).toContain("script-src 'self'");
  await page.getByLabel('Что случилось').fill('Горечь во рту после каши из этой крупы');
  await page.getByRole('button', { name: 'Отправить жалобу' }).click();
  await expect(page.getByRole('button', { name: /^Повторить через [1-3] с$/ })).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveText(/^Слишком много попыток — повторите через 3 с$/);
  await shots(page, 'public-complaint-limited');
  const submit = page.getByRole('button', { name: 'Отправить жалобу' });
  await expect(submit).toBeEnabled({ timeout: 6000 });
  await submit.click();
  await expect(page.getByText('Жалоба отправлена.')).toBeFocused();
  expect(sent).toHaveLength(2);
  // Each submit used its own solved challenge.
  const [first, second] = sent.map((b) => JSON.parse(Buffer.from(b.altcha as string, 'base64').toString()));
  expect(first.number).toBe(4242);
  expect(second.number).toBe(4242);
  expect(first.salt).not.toBe(second.salt);
  expect(await cspViolations(page)).toEqual([]);
  expect(unexpected(w, [/^http 429 POST /])).toEqual([]);
});

test('the ALTCHA worker file fails to load: the form says so, nothing is sent', async ({ page }) => {
  await stand(page, { getCaptchaChallenge: () => challenge(7) });
  let posts = 0;
  await page.route(`**/api/v1/public/batches/${CODE}/complaints`, (route) => {
    posts++;
    return route.fallback();
  });
  await page.route(/\/assets\/altcha\.worker-[^/]+\.js$/, (route) => route.abort());
  await page.goto(`/p/${CODE}/complaint`);
  await page.getByLabel('Что случилось').fill('Горечь во рту после каши из этой крупы');
  await page.getByRole('button', { name: 'Отправить жалобу' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Не удалось подготовить проверку защиты от спама — отправьте ещё раз',
  );
  expect(posts).toBe(0);
});

test('the public chunk fails to load: one reload, then the static «Не удалось загрузить страницу.» (FM15)', async ({
  page,
}) => {
  await stand(page);
  let loads = 0;
  page.on('load', () => void loads++);
  // On /p/ the only lazily imported «main» chunk is the public one.
  await page.route(/\/assets\/main-[^/]+\.js$/, (route) => route.abort());
  await page.goto(`/p/${CODE}`);
  await expect(page.getByText('Не удалось загрузить страницу.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
  expect(loads).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/p/${CODE}$`));
});

test('the entry script itself fails: after 10 s the static block of index.html with a JS-free link (FM18)', async ({
  page,
}) => {
  await stand(page);
  let fail = true;
  await page.route(/\/assets\/index-[^/]+\.js$/, (route) => (fail ? route.abort() : route.fallback()));
  await page.goto(`/p/${CODE}`);
  const text = page.getByText('Не удалось загрузить страницу.');
  await page.waitForTimeout(3000);
  await expect(text).toBeHidden();
  await expect(text).toBeVisible({ timeout: 12000 });
  await shots(page, 'public-boot-failed');
  fail = false;
  await page.getByRole('link', { name: 'Повторить' }).click();
  await expect(title(page)).toHaveText('Пшеница озимая');
  await expect(text).toHaveCount(0);
});

test('performance: LCP on a 360 px phone under mobile throttling', async ({ page }) => {
  const RTT = 150;
  const BYTES_PER_MS = (1.6 * 1024 * 1024) / 8 / 1000;
  await stand(page, {
    getPublicBatch: (_u: URL, body: unknown) => ({
      ...(body as Json),
      product: { ...((body as Json).product as Json), name: 'Пшеница мягкая' },
    }),
  });
  // Answers of the route layer skip the network emulation: they wait the RTT plus their transfer time themselves. The
  // photo is the real 480 px WebP variant the backends derive from the seed photo (FR-FILE-04; mock-api assets).
  const photo = fileURLToPath(
    new URL('../../packages/mock-api/assets/seed/products/wheat-480.webp', import.meta.url),
  );
  const photoBytes = statSync(photo).size;
  await page.route('**/api/v1/**', async (route) => {
    const isPhoto = route.request().url().includes('/public/files/2d4f6a8c-0e1a-4b3c-8d5e-7f9a1b3c5d7e');
    await new Promise((r) => setTimeout(r, RTT + (isPhoto ? photoBytes / BYTES_PER_MS : 0)));
    if (isPhoto) return route.fulfill({ path: photo, contentType: 'image/webp' });
    return route.fallback();
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: RTT,
    downloadThroughput: BYTES_PER_MS * 1000,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.setViewportSize({ width: 360, height: 800 });
  const js: number[] = [];
  page.on('response', async (r) => {
    if (/\/assets\/.+\.js$/.test(r.url())) js.push(Number(r.headers()['content-length'] ?? 0));
  });
  await page.goto(`/p/${CODE}`, { waitUntil: 'load' });
  await expect(title(page)).toHaveText('Пшеница мягкая');
  await page.locator('main figure img').evaluate((img: HTMLImageElement) => img.decode());
  await page.waitForTimeout(500);
  const lcp = await page.evaluate(
    () =>
      new Promise<{ time: number; element: string }>((resolve) => {
        new PerformanceObserver((list) => {
          const last = list.getEntries().at(-1) as PerformanceEntry & { element?: Element };
          resolve({ time: last.startTime, element: last.element?.tagName ?? '?' });
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      }),
  );
  console.log(`LCP ${Math.round(lcp.time)} ms (${lcp.element}); JS files ${js.length}`);
  // Lighthouse's «good» LCP on mobile.
  expect(lcp.time).toBeLessThan(2500);
});
