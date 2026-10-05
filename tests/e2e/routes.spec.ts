import { expect, test, type Page } from '@playwright/test';
import { a11y, demoCode, fixClock, horizontalOverflow, settle, signIn, unexpected, watch } from './helpers';

interface Route {
  to: string | [string, RegExp];
  h1: string | RegExp;
}

const CODE = /^AT-\d{4}-\d{6}$/;
const BASE: Route[] = [
  { to: '/', h1: 'Панель' },
  { to: '/profile', h1: 'Профиль' },
  { to: '/notifications', h1: 'Уведомления' },
  { to: '/reports', h1: 'Отчёты' },
  { to: '/org/staff', h1: 'Сотрудники' },
];
const BATCHES: Route[] = [
  { to: '/batches', h1: 'Партии' },
  { to: ['/batches', CODE], h1: CODE },
];
const WAYBILLS: Route[] = [
  { to: '/waybills', h1: 'Накладные' },
  { to: ['/waybills', /^WB-\d{4}-\d{6}$/], h1: /^WB-\d{4}-\d{6}$/ },
];
const FIELDS: Route[] = [
  { to: '/fields', h1: 'Поля' },
  { to: ['/fields', /^Низинное$/], h1: 'Низинное' },
];

const ROLES: Record<string, { email: string; menu: string[]; routes: Route[] }> = {
  FARMER: {
    email: 'petrov@agrotrace.test',
    menu: ['Панель', 'Поля', 'Партии', 'Накладные', 'Задачи отзыва', 'Сотрудники', 'Отчёты'],
    routes: [
      ...BASE,
      ...FIELDS,
      { to: '/fields/new', h1: 'Новое поле' },
      ...BATCHES,
      { to: '/batches/new', h1: 'Новая партия' },
      ...WAYBILLS,
      { to: '/waybills/new', h1: 'Новая накладная' },
      { to: '/recall-tasks', h1: 'Задачи отзыва' },
    ],
  },
  PROCESSOR: {
    email: 'molkombinat.head@agrotrace.test',
    menu: [
      'Панель',
      'Накладные',
      'Склад',
      'Переработка',
      'Партии',
      'Печать QR',
      'Задачи отзыва',
      'Сотрудники',
      'Отчёты',
    ],
    routes: [
      ...BASE,
      ...BATCHES,
      ...WAYBILLS,
      { to: '/waybills/new', h1: 'Новая накладная' },
      { to: '/stock', h1: 'Склад' },
      { to: '/processing/new', h1: 'Переработка' },
      { to: '/qr', h1: 'Печать QR' },
      { to: '/recall-tasks', h1: 'Задачи отзыва' },
    ],
  },
  LAB: {
    email: 'vetlab.head@agrotrace.test',
    menu: ['Панель', 'Очередь проб', 'Сотрудники', 'Отчёты'],
    routes: [
      ...BASE,
      { to: '/lab/tests', h1: 'Очередь проб' },
      { to: ['/lab/tests', CODE], h1: /^Анализ AT-\d{4}-\d{6}$/ },
    ],
  },
  RETAILER: {
    email: 'provizia.head@agrotrace.test',
    menu: ['Панель', 'Накладные', 'Склад', 'Задачи отзыва', 'Печать QR', 'Партии', 'Сотрудники', 'Отчёты'],
    routes: [
      ...BASE,
      ...BATCHES,
      ...WAYBILLS,
      { to: '/stock', h1: 'Склад' },
      { to: '/qr', h1: 'Печать QR' },
      { to: '/recall-tasks', h1: 'Задачи отзыва' },
    ],
  },
  INSPECTOR: {
    email: 'inspector.head@agrotrace.test',
    menu: [
      'Панель',
      'Партии',
      'Отзывы',
      'Жалобы',
      'Поля',
      'Накладные',
      'Отчёты',
      'Журнал аудита',
      'Сотрудники',
    ],
    routes: [
      ...BASE,
      { to: '/fields', h1: 'Поля' },
      { to: ['/fields', /^Низинное$/], h1: 'Низинное' },
      ...BATCHES,
      ...WAYBILLS,
      { to: '/recalls', h1: 'Отзывы' },
      { to: '/recalls/new', h1: 'Новый отзыв' },
      { to: ['/recalls', CODE], h1: /^Отзыв AT-\d{4}-\d{6}$/ },
      { to: '/complaints', h1: 'Жалобы' },
      { to: ['/complaints', CODE], h1: /^Жалоба на партию AT-\d{4}-\d{6}$/ },
      { to: '/admin/audit', h1: 'Журнал аудита' },
    ],
  },
  ADMIN: {
    email: 'admin@agrotrace.test',
    menu: ['Панель', 'Организации', 'Пользователи', 'Справочники', 'Журнал аудита', 'Отчёты', 'Сотрудники'],
    routes: [
      ...BASE,
      { to: '/fields', h1: 'Поля' },
      { to: ['/fields', /^Низинное$/], h1: 'Низинное' },
      ...BATCHES,
      { to: '/admin/organizations', h1: 'Организации' },
      { to: '/admin/users', h1: 'Пользователи' },
      ...['products', 'substances', 'indicators', 'norms', 'regions'].map((name) => ({
        to: `/admin/dictionaries/${name}`,
        h1: 'Справочники',
      })),
      { to: '/admin/audit', h1: 'Журнал аудита' },
    ],
  },
};

async function visit(page: Page, route: Route): Promise<string[]> {
  await page.setViewportSize({ width: 1280, height: 900 });
  if (typeof route.to === 'string') await page.goto(route.to);
  else {
    await page.goto(route.to[0]);
    await settle(page);
    await page.getByRole('main').getByRole('link', { name: route.to[1] }).first().click();
  }
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(route.h1);
  await settle(page);
  const where = typeof route.to === 'string' ? route.to : `${route.to[0]}/:id`;
  const found = (await a11y(page)).map((v) => `${where} 1280: ${v}`);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(150);
  expect(await horizontalOverflow(page), `${where} at 360 px`).toBeLessThanOrEqual(0);
  found.push(...(await a11y(page)).map((v) => `${where} 360: ${v}`));
  return found;
}

for (const [role, { email, menu, routes }] of Object.entries(ROLES))
  test(`${role}: every route renders without errors, passes axe and fits 360 px`, async ({ page }) => {
    await fixClock(page);
    const w = await watch(page);
    await signIn(page, email, w);
    await settle(page);
    const nav = page.getByRole('navigation', { name: 'Основное меню' });
    await expect(nav.getByRole('link').filter({ hasNotText: 'AgroTrace' })).toHaveText(menu);
    const violations: string[] = [];
    for (const route of routes) violations.push(...(await visit(page, route)));
    await page.goto(role === 'ADMIN' ? '/recall-tasks' : '/admin/organizations');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Нет доступа');
    violations.push(...(await a11y(page)).map((v) => `/403: ${v}`));
    expect(violations).toEqual([]);
    expect(unexpected(w)).toEqual([]);
  });

test('anonymous: the auth screens, the public QR page and «not found» pass the same checks', async ({
  page,
}) => {
  await fixClock(page);
  const w = await watch(page);
  const violations: string[] = [];
  for (const route of [
    { to: '/login', h1: 'Вход' },
    { to: '/password/forgot', h1: 'Восстановление пароля' },
    { to: '/register', h1: 'Регистрация организации' },
    { to: `/p/${demoCode(2)}`, h1: 'Молоко пастеризованное 3,2%' },
    { to: `/p/${demoCode(2)}/complaint`, h1: 'Сообщить о проблеме' },
    { to: '/no-such-page', h1: 'Страница не найдена' },
  ] satisfies Route[])
    violations.push(...(await visit(page, route)));
  expect(violations).toEqual([]);
  expect(unexpected(w)).toEqual([]);
});

test('notification cards at 360 px: the title never runs under the status chip', async ({ page }) => {
  await fixClock(page);
  await signIn(page, 'molkombinat.head@agrotrace.test');
  await page.setViewportSize({ width: 360, height: 780 });
  for (const tab of ['/notifications', '/notifications?tab=unread']) {
    await page.goto(tab);
    await settle(page);
    const overlaps = await page.evaluate(() =>
      [...document.querySelectorAll('tbody tr')].flatMap((tr) => {
        const title = tr.querySelector('td[data-primary]')?.getBoundingClientRect();
        const chip = tr.querySelector('td[data-status-cell] .at-chip')?.getBoundingClientRect();
        if (!title || !chip) return [];
        const text = [...tr.querySelectorAll('td[data-primary] .at-table__primary > *')].map((n) => {
          const r = document.createRange();
          r.selectNodeContents(n);
          return Math.max(...[...r.getClientRects()].map((b) => b.right));
        });
        return Math.max(...text) > chip.left ? [tr.textContent ?? ''] : [];
      }),
    );
    expect(overlaps, tab).toEqual([]);
    expect(await page.locator('tbody tr').count(), tab).toBeGreaterThan(0);
  }
});
