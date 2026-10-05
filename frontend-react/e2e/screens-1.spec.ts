import { expect, test, type Page } from '@playwright/test';
import { focusStaysIn, horizontalOverflow } from './helpers';
import { stand } from './stand';

const SHOTS = 'test-results/shots/screens-1';
const PETROV = {
  id: '0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10',
  name: 'КФХ Петров',
  type: 'FARM',
  logoUrl: '/api/v1/public/files/8e4a1c2b-7d3f-4a6e-b5c9-2f1e0d9c8b7a',
};
const MOLKOMBINAT = {
  id: '4b6d8f0a-2c4e-4a6b-8d0f-1a3c5e7a9b1d',
  name: 'ООО «Молкомбинат Ставропольский»',
  type: 'PROCESSOR',
  logoUrl: '/api/v1/public/files/f1a2b3c4-0000-4000-8000-000000000003',
};
const PROVIZIA = {
  id: '6c8e0a2b-4d6f-4b8d-9f1a-3c5e7a9b1d3f',
  name: 'ООО «Торговый дом Провизия»',
  type: 'RETAILER',
  logoUrl: '/api/v1/public/files/f1a2b3c4-0000-4000-8000-000000000004',
};
const REGION = { code: '33', name: 'Владимирская область' };
const uuid = (n: number) => `f1a2b3c4-1000-4000-8000-${String(n).padStart(12, '0')}`;

const fieldRow = (n: number, name: string, area: string, count: number, last: string | null) => ({
  id: uuid(n),
  name,
  areaHa: area,
  region: REGION,
  geometry: null,
  lastTreatmentAt: last,
  treatmentsCount: count,
  organization: PETROV,
});
const FIELDS = [
  fieldRow(1, 'Низинное', '39.51', 4, '2026-09-10T07:00:00Z'),
  fieldRow(2, 'Пастбище у Колокши', '14.81', 0, null),
  fieldRow(3, 'Участок «Восточный-3»', '124.50', 3, '2026-06-02T07:00:00Z'),
];

const product = (name: string, category: string, img: string | null) => ({
  id: uuid(100 + name.length),
  name,
  category,
  imageUrl: img,
});
const WHEAT = product('Пшеница озимая', 'GRAIN', '/api/v1/public/files/2d4f6a8c-0e1a-4b3c-8d5e-7f9a1b3c5d7e');
const MILK = product(
  'Молоко сырое коровье',
  'DAIRY',
  '/api/v1/public/files/f1a2b3c4-0000-4000-8000-000000000001',
);
const BUTTER = product(
  'Масло сливочное 82,5%',
  'PROCESSED',
  '/api/v1/public/files/f1a2b3c4-0000-4000-8000-000000000002',
);

const batchRow = (n: number, p: typeof WHEAT, status: string, mass: string, holder = PETROV) => ({
  id: uuid(200 + n),
  publicCode: `AT-2026-${String(n).padStart(6, '0')}`,
  product: p,
  massKg: mass,
  status,
  kind: p.category === 'PROCESSED' ? 'DERIVED' : 'RAW',
  holder,
  origin: p.category === 'PROCESSED' ? MOLKOMBINAT : PETROV,
  harvestedAt: p.category === 'PROCESSED' ? null : '2026-09-12T00:00:00Z',
  producedAt: p.category === 'PROCESSED' ? '2026-09-14T10:00:00Z' : null,
  updatedAt: '2026-09-20T08:15:00Z',
  qrGeneratedAt: null,
});
const BATCHES = [
  batchRow(123, WHEAT, 'OnTest', '12480.000'),
  batchRow(27, WHEAT, 'Approved', '8200.500'),
  batchRow(4, MILK, 'Processed', '5230.000', MOLKOMBINAT),
  batchRow(8, BUTTER, 'Recalled', '640.000', PROVIZIA),
  batchRow(19, WHEAT, 'WrittenOff', '1500.000', PROVIZIA),
];

const node = (
  n: number,
  p: typeof WHEAT,
  status: string,
  holder: typeof PETROV,
  depth: number,
  accessible = true,
) => ({
  id: n === 123 ? '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c' : uuid(300 + n),
  publicCode: `AT-2026-${String(n).padStart(6, '0')}`,
  product: p,
  status,
  holder,
  depth,
  accessible,
});
const NODES = [
  node(123, MILK, 'Processed', MOLKOMBINAT, 0),
  node(4, MILK, 'Processed', MOLKOMBINAT, -1),
  node(5, BUTTER, 'OnSale', PROVIZIA, 1, false),
  node(6, BUTTER, 'Recalled', PROVIZIA, 1),
  node(9, BUTTER, 'Sold', PROVIZIA, 2, false),
];
const GRAPH = {
  rootId: NODES[0]!.id,
  depth: 2,
  nodes: NODES,
  edges: [
    { parent: NODES[1]!.id, child: NODES[0]!.id, massUsedKg: '5000.000' },
    { parent: NODES[0]!.id, child: NODES[2]!.id, massUsedKg: '1200.000' },
    { parent: NODES[0]!.id, child: NODES[3]!.id, massUsedKg: '900.000' },
    { parent: NODES[3]!.id, child: NODES[4]!.id, massUsedKg: '300.000' },
  ],
};

const future = new Date(Date.now() + 6 * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
const TREATMENTS = [
  {
    id: uuid(401),
    fieldId: uuid(1),
    substance: { id: uuid(402), name: 'Хлорпирифос', type: 'PESTICIDE', waitingPeriodDays: 30 },
    dose: '1.500',
    doseUnit: 'л/га',
    appliedAt: '2026-09-10T07:00:00Z',
    createdAt: '2026-09-10T15:20:00Z',
    editableUntil: future,
  },
  {
    id: uuid(403),
    fieldId: uuid(1),
    substance: { id: uuid(404), name: 'Аммиачная селитра', type: 'FERTILIZER', waitingPeriodDays: 0 },
    dose: '120.000',
    doseUnit: 'кг/га',
    appliedAt: '2026-08-02T07:00:00Z',
    createdAt: '2026-08-02T15:20:00Z',
    editableUntil: '2026-08-03T15:20:00Z',
  },
];

const page20 = (items: unknown[]) => ({ items, page: 1, size: 20, total: items.length });

async function shots(page: Page, name: string, ready: () => Promise<void>) {
  for (const width of [360, 1280])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await ready();
      await page.waitForTimeout(400);
      await page.evaluate(() => document.fonts.ready);
      expect(await horizontalOverflow(page), `${name} ${width}`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `${SHOTS}/${name}-${width}-${theme}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
}

async function asFarmer(page: Page) {
  await stand(page, {
    listFields: page20(FIELDS),
    getField: FIELDS[0],
    listFieldTreatments: page20(TREATMENTS),
    listBatches: { ...page20(BATCHES), total: 45 },
    getBatchGraph: GRAPH,
  });
}

test('fields, a field, new field', async ({ page }) => {
  await asFarmer(page);
  await page.goto('/fields');
  await shots(page, 'fields', () => expect(page.getByRole('link', { name: 'Низинное' })).toBeVisible());
  await page.goto(`/fields/${uuid(1)}`);
  await shots(page, 'field', () =>
    expect(page.getByRole('cell', { name: 'Хлорпирифос Пестицид' })).toBeVisible(),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Записать обработку' }).click();
  await shots(page, 'treatment-dialog', () => expect(page.getByRole('dialog')).toBeVisible());
  await page.goto('/fields/new');
  await page.getByRole('button', { name: 'Добавить поле' }).last().click();
  await shots(page, 'field-new-errors', () =>
    expect(page.getByText('Обязательное поле').first()).toBeVisible(),
  );
});

test('batches, new batch, batch card tabs', async ({ page }) => {
  await asFarmer(page);
  await page.goto('/batches?status=OnTest');
  await shots(page, 'batches', () =>
    expect(page.getByRole('link', { name: 'AT-2026-000123' })).toBeVisible(),
  );
  await page.goto('/batches/new');
  await shots(page, 'batch-new', () => expect(page.getByLabel('Поле')).toBeVisible());
  for (const tab of ['history', 'path', 'graph', 'tests', 'docs']) {
    await page.goto(`/batches/1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c?tab=${tab}`);
    await shots(page, `batch-${tab}`, () => expect(page.getByRole('tab', { selected: true })).toBeVisible());
  }
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/batches/1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c?tab=graph');
  await page.getByRole('button', { name: 'Открыть граф' }).click();
  await expect(page.locator('.at-graph[data-fullscreen] canvas').first()).toBeVisible();
  await focusStaysIn(page, '.at-graph[data-fullscreen]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/graph-fullscreen-360-light.png`, animations: 'disabled' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Открыть граф' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/graph-fullscreen-360-dark.png`, animations: 'disabled' });
});

test('inspector: registry with the organization filter', async ({ page }) => {
  await stand(page, {
    getMe: (_url: URL, example: unknown) => ({
      ...(example as Record<string, unknown>),
      fullName: 'Павлова Анна Сергеевна',
      roles: ['INSPECTOR'],
      organization: {
        id: uuid(900),
        name: 'Инспекция агропродовольственного надзора',
        type: 'AUTHORITY',
        logoUrl: null,
      },
    }),
    listBatches: page20(BATCHES),
    listFields: page20(FIELDS),
  });
  await page.goto('/batches?orgId=0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10');
  await shots(page, 'batches-inspector', () =>
    expect(page.getByRole('link', { name: 'AT-2026-000123' })).toBeVisible(),
  );
  await page.goto('/fields');
  await shots(page, 'fields-inspector', () =>
    expect(page.getByRole('link', { name: 'Низинное' })).toBeVisible(),
  );
});
