import { expect, test, type Page } from '@playwright/test';
import { demoCode, fixClock, FULL_PAGE_STYLE_PATH, settle, signIn } from './helpers';

const CODE = /^AT-\d{4}-\d{6}$/;
const title = (page: Page) => page.getByRole('heading', { level: 1 });

test.skip(
  process.env.BACK !== undefined && process.env.BACK !== 'mock',
  'the baselines are of the mock world',
);

async function snap(page: Page, name: string): Promise<void> {
  await settle(page);
  for (const width of [360, 1280])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      await page.waitForFunction(() => [...document.images].every((img) => img.complete));
      await expect(page).toHaveScreenshot(`${name}-${width}-${theme}.png`, {
        fullPage: true,
        stylePath: FULL_PAGE_STYLE_PATH,
      });
    }
}

async function openFirst(page: Page, list: string, name: RegExp | string): Promise<void> {
  await page.goto(list);
  await settle(page);
  await page.getByRole('main').getByRole('link', { name }).first().click();
}

const SCREENS: { name: string; as?: string; open: (page: Page) => Promise<void> }[] = [
  { name: 'login', open: (page) => page.goto('/login').then(() => undefined) },
  {
    name: 'dashboard',
    as: 'inspector@agrotrace.test',
    open: async (page) => {
      await page.goto('/');
      await expect(title(page)).toHaveText('Панель');
    },
  },
  {
    name: 'batches',
    as: 'inspector@agrotrace.test',
    open: (page) => page.goto('/batches').then(() => undefined),
  },
  {
    name: 'batch',
    as: 'molkombinat.head@agrotrace.test',
    open: async (page) => {
      await openFirst(page, '/batches?q=000006', /-000006$/);
      await expect(title(page)).toHaveText(/-000006$/);
    },
  },
  {
    name: 'waybill-acceptance',
    as: 'lavka.head@agrotrace.test',
    open: async (page) => {
      await openFirst(page, '/waybills?direction=incoming&status=SENT', /^WB-\d{4}-\d{6}$/);
      await expect(page.getByRole('button', { name: 'Принять' })).toBeVisible();
    },
  },
  {
    name: 'processing',
    as: 'molkombinat.head@agrotrace.test',
    open: async (page) => {
      await page.goto('/processing/new');
      await expect(title(page)).toHaveText('Переработка');
    },
  },
  {
    name: 'lab-test',
    as: 'vetlab.head@agrotrace.test',
    open: async (page) => {
      await openFirst(page, '/lab/tests?status=SAMPLED', CODE);
      await expect(page.getByLabel(/^Значение: /).first()).toBeVisible();
    },
  },
  {
    name: 'recall',
    as: 'inspector@agrotrace.test',
    open: async (page) => {
      await openFirst(page, '/recalls', /-000010$/);
      await expect(page.getByRole('table', { name: 'Задачи изъятия' })).toBeVisible();
    },
  },
  {
    name: 'recall-tasks',
    as: 'provizia.head@agrotrace.test',
    open: async (page) => {
      await page.goto('/recall-tasks?status=all');
      await expect(title(page)).toHaveText('Задачи отзыва');
    },
  },
  {
    name: 'organizations',
    as: 'admin@agrotrace.test',
    open: async (page) => {
      await page.goto('/admin/organizations');
      await expect(title(page)).toHaveText('Организации');
    },
  },
  {
    name: 'public-on-sale',
    open: async (page) => {
      await page.goto(`/p/${demoCode(2)}`);
      await expect(title(page)).toHaveText('Молоко пастеризованное 3,2%');
    },
  },
  {
    name: 'public-recalled',
    open: async (page) => {
      await page.goto(`/p/${demoCode(12)}`);
      await expect(page.getByRole('heading', { level: 2, name: 'Партия отозвана' })).toBeVisible();
    },
  },
];

for (const screen of SCREENS)
  test(`visual: ${screen.name}`, async ({ page }) => {
    await fixClock(page);
    if (screen.as) await signIn(page, screen.as);
    await screen.open(page);
    await snap(page, screen.name);
  });
