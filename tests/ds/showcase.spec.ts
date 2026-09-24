import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const pages = ['index.html', 'forms.html', 'data.html', 'shell.html'];

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
}

for (const p of pages)
  for (const theme of ['light', 'dark'] as const) {
    test(`${p} ${theme} has no a11y violations`, async ({ page }) => {
      await open(page, `/showcase/${p}?theme=${theme}`);
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
    test(`${p} ${theme} screenshot`, async ({ page }) => {
      await open(page, `/showcase/${p}?theme=${theme}`);
      await expect(page).toHaveScreenshot(`${p}-${theme}.png`, { fullPage: true, maxDiffPixelRatio: 0.01 });
    });
  }

test('no horizontal scroll at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  for (const p of pages) {
    await open(page, `/showcase/${p}`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, p).toBeLessThanOrEqual(0);
  }
});

test('table turns into cards below 768px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await open(page, '/showcase/data.html');
  const display = await page
    .locator('.at-table[data-cards] tbody tr')
    .first()
    .evaluate((el) => getComputedStyle(el).display);
  expect(display).not.toBe('table-row');
});
