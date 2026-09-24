import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const pages = ['index.html', 'forms.html', 'data.html', 'shell.html'];
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
}

for (const p of pages)
  for (const theme of ['light', 'dark'] as const) {
    test(`${p} ${theme} has no a11y violations`, async ({ page }) => {
      await open(page, `/showcase/${p}?theme=${theme}`);
      const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });

    // Tight comparison (config: maxDiffPixels 50, threshold 0.05): a changed date format or a
    // single chip colour fails. The fixed bottom nav would be painted mid-page in a full-page
    // capture, so it is masked there and checked in its own viewport shot below.
    test(`${p} ${theme} screenshot`, async ({ page }) => {
      await open(page, `/showcase/${p}?theme=${theme}`);
      await expect(page).toHaveScreenshot(`${p}-${theme}.png`, {
        fullPage: true,
        mask: [page.locator('.at-bottom-nav')],
      });
    });
  }

test('shell viewport with the bottom navigation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'the bottom nav exists below 768 px only');
  for (const theme of ['light', 'dark'] as const) {
    await open(page, `/showcase/shell.html?theme=${theme}`);
    await expect(page.locator('.at-bottom-nav')).toBeVisible();
    await expect(page).toHaveScreenshot(`shell-viewport-${theme}.png`);
  }
});

test('no horizontal scroll at 360px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'viewport-independent: run once');
  await page.setViewportSize({ width: 360, height: 780 });
  for (const p of pages)
    for (const q of ['', '?theme=light', '?theme=dark']) {
      await open(page, `/showcase/${p}${q}`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${p}${q}`).toBeLessThanOrEqual(0);
    }
});

test('table turns into cards below 768px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'card mode is a < 768 px layout');
  await open(page, '/showcase/data.html?theme=light');
  const table = page.locator('.at-table[data-cards]').first();
  const rows = table.locator('tbody tr');
  expect(await rows.count()).toBeGreaterThan(1);
  await expect(rows.first()).toBeVisible();
  await expect(table.locator('thead')).toBeHidden();
  await expect(page.locator('.at-table-mobilebar').first()).toBeVisible();
  const cards = await rows.evaluateAll((trs) =>
    trs.map((tr) => ({
      display: getComputedStyle(tr).display,
      labels: [...tr.querySelectorAll('td[data-label]:not([data-primary]):not([data-status-cell])')].map(
        (td) => [td.getAttribute('data-label'), getComputedStyle(td, '::before').content],
      ),
    })),
  );
  for (const c of cards) {
    expect(c.display).not.toBe('table-row');
    expect(c.labels.length).toBeGreaterThan(0);
    for (const [label, content] of c.labels) expect(content).toBe(`"${label}"`);
  }
});

test('table keeps its header and hides the mobile bar from 768px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop and rail layouts');
  await open(page, '/showcase/data.html?theme=light');
  await expect(page.locator('.at-table[data-cards] thead').first()).toBeVisible();
  await expect(page.locator('.at-table-mobilebar').first()).toBeHidden();
  expect(
    await page
      .locator('.at-table[data-cards] tbody tr')
      .first()
      .evaluate((el) => getComputedStyle(el).display),
  ).toBe('table-row');
});

test('small controls keep a full touch target', async ({ page }, testInfo) => {
  await open(page, '/showcase/data.html?theme=light');
  const touch = testInfo.project.name === 'mobile' ? 44 : 40;
  const selectors = ['.at-table__sort', '.at-table__select .at-check', '.at-button[data-size="s"]'];
  let checked = 0;
  for (const sel of selectors) {
    for (const el of await page.locator(sel).all()) {
      if (!(await el.isVisible())) continue;
      await el.evaluate((n) => n.scrollIntoView({ block: 'center', inline: 'center' }));
      const reach = await el.evaluate((node, t) => {
        const r = node.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const d = t / 2 - 1;
        const probes = [
          [cx, cy - d],
          [cx, cy + d],
          [cx - Math.min(d, r.width / 2 + d), cy],
          [cx + Math.min(d, r.width / 2 + d), cy],
        ];
        const misses = probes.filter(([x, y]) => {
          const hit = document.elementFromPoint(x!, y!);
          return !hit || !(node === hit || node.contains(hit));
        });
        return misses.length
          ? `${node.outerHTML.slice(0, 80)} misses ${JSON.stringify(misses.map(([x, y]) => [Math.round(x! - cx), Math.round(y! - cy), document.elementFromPoint(x!, y!)?.className]))}`
          : 'ok';
      }, touch);
      expect(reach, `${sel} reaches ${touch}px`).toBe('ok');
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(2);
});

test('.at-mono wins over component font shorthands', async ({ page }) => {
  await open(page, '/showcase/data.html?theme=light');
  const families = await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="mono-probe">' +
        '<h2 class="at-card__title at-mono">AT-2026-000123</h2>' +
        '<h2 class="at-dialog__title at-mono">AT-2026-000123</h2>' +
        '<h1 class="at-page__title at-mono">AT-2026-000123</h1>' +
        '<h2 class="at-card__title"><span class="at-mono">AT-2026-000123</span></h2>' +
        '</div>',
    );
    return [...document.querySelectorAll('#mono-probe .at-mono')].map(
      (el) => getComputedStyle(el).fontFamily,
    );
  });
  expect(families).toHaveLength(4);
  for (const f of families) expect(f.split(',')[0]!.replace(/['"]/g, '').trim()).toBe('JetBrains Mono');
});
