/**
 * P5 (R89/I6): /api/v1/docs through the gateway — under the gateway's CSP (`script-src 'self'`, no inline script)
 * Swagger UI renders the contract with zero console errors, zero CSP violations and no request to another origin.
 */
import { test, expect } from '@playwright/test';

const BACK = process.env.DOCS_BACKEND ?? 'express';
const ORIGIN = `http://react-${BACK}.localhost`;

test(`Swagger UI of ${BACK} renders under the gateway CSP`, async ({ page }) => {
  const errors: string[] = [];
  const foreign: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy/i.test(m.text()))
      errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    if (!r.url().startsWith(`${ORIGIN}/`) && !r.url().startsWith('data:')) foreign.push(r.url());
  });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  // securitypolicyviolation events, recorded before any page script runs.
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });

  const res = await page.goto(`${ORIGIN}/api/v1/docs`);
  expect(res?.status()).toBe(200);
  const headers = await res!.allHeaders();
  expect(headers['x-backend']).toBe(BACK);
  expect(headers['content-security-policy']).toContain("script-src 'self'");

  await expect(page.locator('.swagger-ui .info .title')).toContainText('AgroTrace', { timeout: 20000 });
  const ops = page.locator('.opblock');
  await expect(ops.first()).toBeVisible();
  expect(await ops.count()).toBeGreaterThan(80);
  // Expanding an operation renders its schemas (no lazy asset may be blocked).
  await ops.first().locator('.opblock-summary').click();
  await expect(ops.first().locator('.responses-wrapper')).toBeVisible();

  const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  expect(csp).toEqual([]);
  expect(errors).toEqual([]);
  expect(foreign).toEqual([]);
});
