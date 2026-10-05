import { expect, test, type Page } from '@playwright/test';
import { horizontalOverflow } from './helpers';
import { stand } from './stand';

const SHOTS = 'test-results/shots/screens-2';
const uuid = (n: number) => `f1a2b3c4-2000-4000-8000-${String(n).padStart(12, '0')}`;
type Org = { id: string; name: string; type: string; logoUrl: string | null };
const PETROV: Org = {
  id: '0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10',
  name: 'КФХ Петров',
  type: 'FARM',
  logoUrl: '/api/v1/public/files/8e4a1c2b-7d3f-4a6e-b5c9-2f1e0d9c8b7a',
};
const MUKOMOL = {
  id: '4b6d8f0a-2c4e-4a6b-8d0f-1a3c5e7a9b1d',
  name: 'ООО «Кубанский мукомол»',
  type: 'PROCESSOR',
  logoUrl: null,
};
const MARKET = {
  id: '6c8e0a2b-4d6f-4b8d-9f1a-3c5e7a9b1d3f',
  name: 'ООО «Кубань-Маркет»',
  type: 'RETAILER',
  logoUrl: null,
};
const WHEAT = {
  id: '7a2b4c6d-8e0f-4a1b-9c3d-5e7f9a1b3c5d',
  name: 'Пшеница озимая',
  category: 'GRAIN',
  imageUrl: '/api/v1/public/files/2d4f6a8c-0e1a-4b3c-8d5e-7f9a1b3c5d7e',
};
const FLOUR = {
  id: 'a4c6e8f0-2b4d-4f6a-8c0e-4b6d8f0a2c4e',
  name: 'Мука пшеничная высшего сорта',
  category: 'PROCESSED',
  imageUrl: null,
};

const batch = (
  n: number,
  status: string,
  mass: string,
  holder = PETROV,
  extra: Record<string, unknown> = {},
) => ({
  id: n === 123 ? '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c' : uuid(n),
  publicCode: `AT-2026-${String(n).padStart(6, '0')}`,
  product: WHEAT,
  massKg: mass,
  status,
  kind: 'RAW',
  holder,
  origin: PETROV,
  harvestedAt: '2026-09-12T06:00:00Z',
  producedAt: null,
  updatedAt: '2026-09-20T08:15:00Z',
  qrGeneratedAt: null,
  ...extra,
});
const page20 = (items: unknown[]) => ({ items, page: 1, size: 20, total: items.length });

const item = (b: ReturnType<typeof batch>, declared: string, actual: string | null = null) => ({
  batch: b,
  massDeclaredKg: declared,
  massActualKg: actual,
  discrepancyPercent: actual ? '3.21' : null,
  discrepancyAct: actual ? 'Недостача 400 кг при контрольном взвешивании, акт № 17' : null,
});
const waybill = (
  n: number,
  status: string,
  items: ReturnType<typeof item>[],
  extra: Record<string, unknown> = {},
) => ({
  id: n === 17 ? '7e9a1c3e-5b7d-4f9b-a1c3-5e7a9c1e3b5d' : uuid(500 + n),
  number: `WB-2026-${String(n).padStart(6, '0')}`,
  status,
  sender: PETROV,
  receiver: MUKOMOL,
  items,
  createdAt: '2026-09-19T07:50:00Z',
  sentAt: status === 'DRAFT' ? null : '2026-09-19T08:15:00Z',
  acceptedAt: status === 'ACCEPTED' ? '2026-09-20T09:30:00Z' : null,
  rejectReason: status === 'REJECTED' ? 'Влажность зерна 17% при допустимых 14%' : null,
  version: 2,
  actions: [] as string[],
  ...extra,
});
const B123 = batch(123, 'InTransit', '12480.000');
const B27 = batch(27, 'InTransit', '8200.500');
const WAYBILLS = [
  waybill(17, 'SENT', [item(B123, '12480.000'), item(B27, '8200.500')], { actions: ['accept', 'reject'] }),
  waybill(16, 'DRAFT', [item(batch(31, 'Approved', '5000.000'), '5000.000')]),
  waybill(15, 'ACCEPTED', [item(batch(12, 'Accepted', '12080.000', MUKOMOL), '12480.000', '12080.000')]),
  waybill(14, 'REJECTED', [item(batch(9, 'Approved', '3000.000'), '3000.000')]),
];

async function shots(page: Page, name: string, ready: () => Promise<void>) {
  for (const width of [360, 1280])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await ready();
      await page.evaluate(() => document.fonts.ready);
      expect(await horizontalOverflow(page), `${name} ${width}`).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `${SHOTS}/${name}-${width}-${theme}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
}

const role = (roles: string[], organization: unknown) => (_u: URL, example: unknown) => ({
  ...(example as Record<string, unknown>),
  roles,
  organization,
});

test('farmer: waybills, a new waybill with its errors, a draft', async ({ page }) => {
  await stand(page, {
    listWaybills: page20(WAYBILLS),
    getWaybill: WAYBILLS[1],
    listBatches: page20([
      batch(123, 'Approved', '12480.000'),
      batch(27, 'Accepted', '8200.500'),
      batch(31, 'Approved', '5000.000'),
    ]),
  });
  await page.goto('/waybills');
  await shots(page, 'waybills', () =>
    expect(page.getByRole('link', { name: 'WB-2026-000017' })).toBeVisible(),
  );
  await page.goto('/waybills/new?batchId=1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c');
  await page.getByRole('button', { name: 'Создать накладную' }).click();
  await shots(page, 'waybill-new-errors', () =>
    expect(page.getByText('Обязательное поле').first()).toBeVisible(),
  );
  await page.goto(`/waybills/${uuid(516)}`);
  await shots(page, 'waybill-draft', () =>
    expect(page.getByRole('heading', { name: 'WB-2026-000016' })).toBeVisible(),
  );
});

test('processor: acceptance with the live discrepancy and the act; the reject dialog; stock', async ({
  page,
}) => {
  await stand(page, {
    getMe: role(['PROCESSOR'], MUKOMOL),
    getWaybill: WAYBILLS[0],
    listBatches: page20([
      batch(12, 'Accepted', '12080.000', MUKOMOL),
      batch(40, 'Approved', '7200.000', MUKOMOL),
    ]),
  });
  await page.goto('/waybills/7e9a1c3e-5b7d-4f9b-a1c3-5e7a9c1e3b5d');
  const actual = page.getByLabel('Фактическая масса AT-2026-000123');
  await actual.fill('12080');
  await shots(page, 'waybill-accept', () => expect(page.getByText('Больше 2%: нужен акт')).toBeVisible());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Отказаться' }).click();
  await shots(page, 'waybill-reject-dialog', () => expect(page.getByRole('dialog')).toBeVisible());
  await page.goto('/stock');
  await shots(page, 'stock-processor', () =>
    expect(page.getByRole('link', { name: 'AT-2026-000012' })).toBeVisible(),
  );
});

test('processor: the processing wizard — every step on wide screens, one per screen below 768 px', async ({
  page,
}) => {
  await stand(page, {
    getMe: role(['PROCESSOR'], MUKOMOL),
    listBatches: page20([
      batch(12, 'Accepted', '12080.000', MUKOMOL),
      batch(13, 'Accepted', '6000.000', MUKOMOL),
    ]),
    listDictionary: (u: URL, example: unknown) =>
      u.pathname.endsWith('/products')
        ? page20([
            {
              ...WHEAT,
              lossNormPercent: '2.00',
              mercuryCode: null,
              createdAt: '2026-06-01T00:00:00Z',
              updatedAt: '2026-06-01T00:00:00Z',
              deletedAt: null,
            },
            {
              ...FLOUR,
              lossNormPercent: '25.00',
              mercuryCode: null,
              createdAt: '2026-06-01T00:00:00Z',
              updatedAt: '2026-06-01T00:00:00Z',
              deletedAt: null,
            },
          ])
        : example,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/processing/new?batchId=${uuid(12)}`);
  await page.getByLabel('Продукт выхода 1').selectOption({ label: 'Мука пшеничная высшего сорта' });
  await page.getByLabel('Масса выхода 1').fill('12000');
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await expect(page.getByText(/Выход переработки/)).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: `${SHOTS}/processing-1280-${theme}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`/processing/new?batchId=${uuid(12)}`);
  for (const [i, next] of [
    ['inputs', true],
    ['outputs', true],
    ['balance', false],
  ] as const) {
    if (i === 'outputs') {
      await page.getByLabel('Продукт выхода 1').selectOption({ label: 'Мука пшеничная высшего сорта' });
      await page.getByLabel('Масса выхода 1').fill('9000');
    }
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `${SHOTS}/processing-${i}-360-${theme}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
    if (next) await page.getByRole('button', { name: 'Далее' }).click();
  }
});

test('retailer: stock with its actions, QR printing and the QR dialog', async ({ page }) => {
  const own = [
    batch(12, 'Accepted', '12080.000', MARKET),
    batch(21, 'OnSale', '640.000', MARKET, { qrGeneratedAt: '2026-09-18T10:00:00Z' }),
  ];
  await stand(page, { getMe: role(['RETAILER'], MARKET), listBatches: page20(own) });
  await page.goto('/stock');
  await shots(page, 'stock-retailer', () =>
    expect(page.getByRole('link', { name: 'AT-2026-000012' })).toBeVisible(),
  );
  await page.goto('/qr');
  await shots(page, 'qr', () => expect(page.getByRole('link', { name: 'AT-2026-000021' })).toBeVisible());
  await page.getByRole('button', { name: 'Сформировать QR-код AT-2026-000012' }).click();
  await shots(page, 'qr-dialog', () => expect(page.getByRole('dialog').getByRole('img')).toBeVisible());
});
