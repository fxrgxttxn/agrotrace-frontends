import { expect, test, type Page } from '@playwright/test';
import { horizontalOverflow } from './helpers';
import { stand } from './stand';

const SHOTS = 'test-results/shots/screens-3';
type Json = Record<string, unknown>;
const LAB_ORG = {
  id: '5a7c9e1b-3d5f-4a7c-9e1b-3d5f7a9c1e3b',
  name: 'ИЛ «Кубаньтест»',
  type: 'LAB',
  logoUrl: null,
};
const AUTHORITY = {
  id: 'f1a2b3c4-5000-4000-8000-000000000900',
  name: 'Инспекция агропродовольственного надзора',
  type: 'AUTHORITY',
  logoUrl: null,
};
const uuid = (n: number) => `f1a2b3c4-5000-4000-8000-${String(n).padStart(12, '0')}`;

async function shots(page: Page, name: string, ready: () => Promise<void>) {
  for (const width of [360, 1280])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await ready();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      expect(await horizontalOverflow(page), `${name} ${width}`).toBeLessThanOrEqual(0);
      const unfix = await page.addStyleTag({ content: '.at-bottom-nav { position: static !important; }' });
      await page.screenshot({ fullPage: true, animations: 'disabled' });
      await page.screenshot({
        path: `${SHOTS}/${name}-${width}-${theme}.png`,
        fullPage: true,
        animations: 'disabled',
      });
      await unfix.evaluate((n) => (n as Element).remove());
    }
}

const role = (roles: string[], organization: unknown) => (_u: URL, example: unknown) => ({
  ...(example as Json),
  roles,
  organization,
});

const share = (key: number, name: string, tested: number, failed: number, pct: string) => ({
  key: uuid(key),
  name,
  tested,
  failed,
  share: pct,
});
const INSPECTOR = {
  scope: 'inspector',
  period: { from: '2026-08-28', to: '2026-09-26' },
  batchesTotal: 1284,
  rejectedShare: {
    byProduct: [
      share(1, 'Молоко сырое коровье', 12, 3, '25.00'),
      share(2, 'Пшеница озимая', 40, 5, '12.50'),
      share(3, 'Мука пшеничная высшего сорта', 18, 1, '5.56'),
      share(4, 'Подсолнечник', 9, 0, '0.00'),
    ],
    byFarm: [
      share(11, 'КФХ Петров', 22, 4, '18.18'),
      share(12, 'ООО «Агрохолдинг Кубань»', 30, 3, '10.00'),
      share(13, 'КФХ «Рассвет»', 11, 0, '0.00'),
    ],
  },
  activeRecalls: 3,
  avgRecallHours: '18.25',
  violationsByRegion: [
    { code: '23', name: 'Краснодарский край', count: 6 },
    { code: '61', name: 'Ростовская область', count: 2 },
    { code: '26', name: 'Ставропольский край', count: 1 },
    { code: '50', name: 'Московская область', count: 0 },
  ],
};
const ORG = {
  scope: 'org',
  period: { from: '2026-08-28', to: '2026-09-26' },
  organization: {
    id: '0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10',
    name: 'КФХ Петров',
    type: 'FARM',
    logoUrl: null,
  },
  byStatus: (
    [
      ['Created', 2],
      ['OnTest', 4],
      ['Approved', 11],
      ['InTransit', 3],
      ['Accepted', 0],
      ['Processed', 0],
      ['OnSale', 0],
      ['Sold', 0],
      ['Blocked', 1],
      ['Recalled', 1],
      ['WrittenOff', 2],
    ] as const
  ).map(([status, count]) => ({ status, count })),
  labResults: { pass: 17, fail: 2 },
  openTasks: 2,
  overdueTasks: 1,
};

test('dashboards: inspector (metrics, shares, regions, the table view), organization, laboratory', async ({
  page,
}) => {
  await stand(page, { getMe: role(['INSPECTOR'], AUTHORITY), getDashboard: INSPECTOR });
  await page.goto('/');
  await shots(page, 'dashboard-inspector', () =>
    expect(page.locator('.at-chart__canvas svg').first()).toBeVisible(),
  );
  await page.getByText('Таблица значений').first().click();
  await shots(page, 'dashboard-inspector-table', () =>
    expect(page.getByRole('table', { name: 'Доля брака по продуктам' })).toBeVisible(),
  );

  await stand(page, { getDashboard: ORG });
  await page.goto('/');
  await shots(page, 'dashboard-org', () =>
    expect(page.locator('.at-chart__canvas svg').first()).toBeVisible(),
  );

  await stand(page, {
    getMe: role(['LAB'], LAB_ORG),
    getDashboard: {
      scope: 'lab',
      period: { from: '2026-08-28', to: '2026-09-26' },
      organization: LAB_ORG,
      queue: 14,
      overdue: 2,
      completed: 57,
      failed: 4,
      avgHours: '52.40',
    },
  });
  await page.goto('/');
  await shots(page, 'dashboard-lab', () => expect(page.getByText('Среднее время анализа')).toBeVisible());
});

type Test = Record<string, unknown> & { batch: Json };

test('laboratory: the queue, the card with live norms and the FAIL confirmation, the report, a done test', async ({
  page,
}) => {
  await stand(page, {
    getMe: role(['LAB'], LAB_ORG),
    listLabTests: () => {
      const t = {
        id: '8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e',
        lab: LAB_ORG,
        reason: 'RISK',
        status: 'SAMPLED',
        conclusion: null,
        dueAt: '2026-09-30T06:05:00Z',
        overdue: false,
        createdAt: '2026-09-23T06:05:00Z',
        sampledAt: '2026-09-24T09:30:00Z',
        completedAt: null,
        hasProtocol: false,
      };
      return {
        items: [
          t,
          {
            ...t,
            id: uuid(21),
            status: 'QUEUED',
            sampledAt: null,
            overdue: true,
            dueAt: '2026-09-22T06:05:00Z',
          },
          { ...t, id: uuid(22), status: 'DONE', conclusion: 'FAIL', completedAt: '2026-09-25T11:40:00Z' },
        ].map((x, i) => ({ ...x, batch: BATCH(i) })),
        page: 1,
        size: 20,
        total: 3,
      };
    },
    getLabTest: (_u: URL, example: unknown) => pendingOf(example as Test),
  });
  await page.goto('/lab/tests');
  await shots(page, 'lab-queue', () =>
    expect(page.getByRole('link', { name: 'AT-2026-000123' })).toBeVisible(),
  );

  await page.goto('/lab/tests/8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e');
  await page.getByLabel('Значение: Нитраты').fill('612');
  await page.getByLabel('Значение: Свинец').fill('0,15');
  await shots(page, 'lab-test-live', () =>
    expect(page.getByText('Заключение: Превышение нормативов')).toBeVisible(),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Внести результаты' }).click();
  await shots(page, 'lab-test-fail-dialog', () => expect(page.getByRole('dialog')).toBeVisible());

  await stand(page, { getMe: role(['LAB'], LAB_ORG) });
  await page.goto('/lab/tests/8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e');
  await shots(page, 'lab-test-done', () =>
    expect(page.getByRole('table', { name: 'Показатели' })).toBeVisible(),
  );
});

const BATCH = (i: number) => ({
  id: i === 0 ? '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c' : uuid(100 + i),
  publicCode: `AT-2026-${String(123 + i * 11).padStart(6, '0')}`,
  product: {
    id: '7a2b4c6d-8e0f-4a1b-9c3d-5e7f9a1b3c5d',
    name: i === 1 ? 'Молоко сырое коровье' : 'Пшеница озимая',
    category: 'GRAIN',
    imageUrl: null,
  },
  massKg: '12480.000',
  status: 'OnTest',
  kind: 'RAW',
  holder: { id: '0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10', name: 'КФХ Петров', type: 'FARM', logoUrl: null },
  origin: { id: '0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10', name: 'КФХ Петров', type: 'FARM', logoUrl: null },
  harvestedAt: '2026-09-18T06:00:00Z',
  producedAt: null,
  updatedAt: '2026-09-18T06:05:00Z',
  qrGeneratedAt: null,
});

const pendingOf = (done: Test): Test => ({
  ...done,
  batch: { ...done.batch, status: 'OnTest' },
  status: 'SAMPLED',
  conclusion: null,
  completedAt: null,
  results: [],
  recallId: null,
  version: 2,
  actions: ['submitResults', 'uploadProtocol'],
});

test('inspector: the unscheduled test dialog on the batch card', async ({ page }) => {
  await stand(page, { getMe: role(['INSPECTOR'], AUTHORITY) });
  await page.goto('/batches/1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Назначить анализ' }).click();
  await shots(page, 'batch-assign-lab', () => expect(page.getByRole('dialog')).toBeVisible());
});
