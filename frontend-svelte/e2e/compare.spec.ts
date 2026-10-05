import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { mockApi } from './contract';

const REACT = 'http://react-express.localhost:8089';
const SHOTS = 'test-results/shots';
const MAX_DIFF = 0.01;

async function reactUp(page: Page): Promise<boolean> {
  try {
    const res = await page.goto(`${REACT}/p/probe`, { timeout: 5000 });
    return Boolean(res?.ok());
  } catch {
    return false;
  }
}

async function diff(page: Page, a: string, b: string): Promise<number> {
  const url = (f: string) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
  await page.goto('about:blank');
  return page.evaluate(
    async ([ua, ub]) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.src = src;
        });
      const [ia, ib] = await Promise.all([load(ua!), load(ub!)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return 1;
      const px = (img: HTMLImageElement) => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height).data;
      };
      const [da, db] = [px(ia), px(ib)];
      let bad = 0;
      for (let i = 0; i < da.length; i += 4)
        if (
          Math.max(
            Math.abs(da[i]! - db[i]!),
            Math.abs(da[i + 1]! - db[i + 1]!),
            Math.abs(da[i + 2]! - db[i + 2]!),
          ) > 24
        )
          bad += 1;
      return bad / (da.length / 4);
    },
    [url(a), url(b)],
  );
}

test('shell: Svelte = React at 360 / 900 / 1280, light and dark (≤ 1 % pixels)', async ({
  page,
  context,
}) => {
  test.skip(!(await reactUp(page)), 'the React stand (./at fe:gateway react) is not up — comparison skipped');
  await mockApi(context);
  const results: { what: string; share: number }[] = [];
  for (const width of [360, 900, 1280])
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width === 360 ? 780 : 800 });
      await page.emulateMedia({ colorScheme: scheme });
      const files: string[] = [];
      for (const [name, base] of [
        ['svelte', ''],
        ['react', REACT],
      ] as const) {
        const res = await page.goto(`${base}/batches`);
        expect(res?.headers()['x-frontend'], `served by the ${name} build`).toBe(name);
        await expect(page.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
        await expect(page.locator('a.at-bell .at-bell__count')).toHaveText('3');
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() =>
          Promise.all(
            [...document.images].map((i) => (i.complete ? null : new Promise((r) => (i.onload = r)))),
          ),
        );
        const file = `${SHOTS}/compare-${name}-${width}-${scheme}.png`;
        await page.addStyleTag({
          content:
            '.at-shell__main .at-page > :not(.at-page__header), .at-page__actions { visibility: hidden !important; }',
        });
        await page.screenshot({ path: file });
        files.push(file);
      }
      const share = await diff(page, files[0]!, files[1]!);
      results.push({ what: `${width} ${scheme}`, share });
    }
  console.log(
    `svelte vs react, differing pixels: ${results.map((r) => `${r.what}: ${(r.share * 100).toFixed(2)} %`).join('; ')}`,
  );
  for (const r of results) expect(r.share, r.what).toBeLessThanOrEqual(MAX_DIFF);
});
