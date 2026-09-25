import type { Page } from '@playwright/test';

// Console, page errors, failed responses and CSP violations of a page (the same watch as the React smoke spec).

export interface Watch {
  problems: string[];
}

/** Answers that are expected, not defects: the anonymous start-up refresh (401). */
const EXPECTED = [/^http 401 POST \/api\/v1\/auth\/refresh$/];

export function unexpected(w: Watch): string[] {
  return w.problems.filter(
    (p) => !/^console: Failed to load resource/.test(p) && !EXPECTED.some((re) => re.test(p)),
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
