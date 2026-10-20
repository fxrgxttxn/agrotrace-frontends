import { expect, test } from '@playwright/test';
import { chunkWith } from './chunks';
import { contractExample, mockApi } from './contract';

// README «График»: the ECharts library is its own chunk, requested once per document however many charts mount; when
// it cannot load every chart says so, and «Повторить» loads the page anew through the reload-once guard (FM15) — the
// browser keeps the failed module, so only a new document can ask for it again. As the React app's chunks.spec.ts.

const ECHARTS = chunkWith(/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?echarts\//);

test('the chart library chunk fails: every chart says so; «Повторить» loads the page anew (FM15), then they draw', async ({
  page,
  context,
}) => {
  await mockApi(context, {
    getMe: {
      body: {
        ...(contractExample('getMe').body as Record<string, unknown>),
        roles: ['INSPECTOR'],
        organization: {
          id: 'f1a2b3c4-5000-4000-8000-000000000900',
          name: 'Инспекция',
          type: 'AUTHORITY',
          logoUrl: null,
        },
      },
    },
    getDashboard: { example: 'inspector' },
  });
  let loads = 0;
  let asked = 0;
  let block = true;
  page.on('load', () => void loads++);
  await context.route(`**${ECHARTS}`, (route) => {
    asked++;
    return block ? route.abort('failed') : route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.locator('.at-chart__failed')).toHaveCount(3);
  await expect(page.locator('.at-chart__failed').first().getByRole('alert')).toHaveText(
    'График не загрузился.',
  );
  // One request for all the charts, none after the failure (the browser keeps the failed module).
  await page.waitForTimeout(500);
  expect(asked).toBe(1);
  block = false;
  await page.locator('.at-chart__failed').first().getByRole('button', { name: 'Повторить' }).click();
  await expect(page.locator('.at-chart__canvas svg')).toHaveCount(3);
  expect(loads).toBe(2);
  await expect(page.locator('.at-chart__failed')).toHaveCount(0);
});
