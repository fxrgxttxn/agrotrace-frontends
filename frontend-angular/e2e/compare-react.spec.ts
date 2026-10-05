import { lookup } from 'node:dns/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { exampleBody, mockApi, type Overrides } from './api';
import { PRODUCTION } from './helpers';

test.skip(!process.env['AT_COMPARE'], 'opt-in: AT_COMPARE=1 (needs the React stand on host port 8089)');
test.use(PRODUCTION);
test.describe.configure({ mode: 'serial' });
test.setTimeout(300000);

const TOKEN = 'k3Jp9_Qw8Zr2Xy7Lm4Nb6Vc1Hd5Tf0Gs-Ae3Rt8Yu';
const SHOTS = 'test-results/shots/a2';
const SOON = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');

interface Screen {
  name: string;
  path: string;
  signedIn?: boolean;
  overrides?: () => Promise<Overrides>;
  act?: (page: Page) => Promise<void>;
  ready: (page: Page) => Promise<void>;
}

const heading = (page: Page, name: string) =>
  expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();

const SCREENS: Screen[] = [
  { name: 'login', path: '/login', signedIn: false, ready: (p) => heading(p, 'Вход') },
  {
    name: 'login-2fa',
    path: '/login?next=%2Fbatches',
    signedIn: false,
    overrides: async () => ({
      'POST /auth/login': {
        status: 200,
        contentType: 'application/json',
        body: { twoFactorRequired: true, challengeId: 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f' },
      },
    }),
    act: async (page) => {
      await page.getByLabel('Email').fill('inspector.head@agrotrace.test');
      await page.getByLabel('Пароль').fill('agrotrace-demo');
      await page.getByRole('button', { name: 'Войти' }).click();
    },
    ready: (p) => heading(p, 'Код подтверждения'),
  },
  {
    name: 'login-errors',
    path: '/login',
    signedIn: false,
    act: async (page) => {
      await page.getByLabel('Email').fill('not-an-email');
      await page.getByRole('button', { name: 'Войти' }).click();
    },
    ready: (p) => expect(p.getByLabel('Пароль')).toHaveAttribute('aria-invalid', 'true'),
  },
  {
    name: 'forgot',
    path: '/password/forgot',
    signedIn: false,
    ready: (p) => heading(p, 'Восстановление пароля'),
  },
  {
    name: 'forgot-sent',
    path: '/password/forgot',
    signedIn: false,
    act: async (page) => {
      await page.getByLabel('Email').fill('nobody@example.org');
      await page.getByRole('button', { name: 'Отправить ссылку' }).click();
    },
    ready: (p) => expect(p.getByText(/Если адрес nobody@example\.org/)).toBeVisible(),
  },
  {
    name: 'reset',
    path: `/password/reset/${TOKEN}`,
    signedIn: false,
    ready: (p) => heading(p, 'Новый пароль'),
  },
  {
    name: 'reset-dead',
    path: '/password/reset/short',
    signedIn: false,
    ready: (p) => expect(p.getByText('Ссылка устарела или уже использована.')).toBeVisible(),
  },
  { name: 'invite', path: `/invite/${TOKEN}`, signedIn: false, ready: (p) => heading(p, 'Приглашение') },
  {
    name: 'invite-signed-in',
    path: `/invite/${TOKEN}`,
    ready: (p) => expect(p.getByText(/^Вы вошли как/)).toBeVisible(),
  },
  {
    name: 'register',
    path: '/register',
    signedIn: false,
    ready: (p) => expect(p.getByRole('option', { name: 'Краснодарский край' })).toBeAttached(),
  },
  {
    name: 'profile',
    path: '/profile',
    ready: (p) => expect(p.getByRole('switch', { name: 'Email' })).toBeVisible(),
  },
  {
    name: 'profile-2fa',
    path: '/profile',
    overrides: async () => ({
      'GET /me': {
        status: 200,
        contentType: 'application/json',
        body: { ...(await exampleBody('GET /me')), roles: ['INSPECTOR'] },
      },
    }),
    act: async (page) => {
      await page.getByRole('button', { name: 'Настроить' }).click();
    },
    ready: (p) => expect(p.getByRole('img', { name: 'QR-код для приложения-аутентификатора' })).toBeVisible(),
  },
  {
    name: 'profile-telegram-code',
    path: '/profile',
    overrides: async () => ({
      'GET /me/channels': {
        status: 200,
        contentType: 'application/json',
        body: { email: true, telegram: false, telegramLinked: false },
      },
      'POST /me/telegram-code': {
        status: 201,
        contentType: 'application/json',
        body: { code: 'K7M2Q9XA', expiresAt: SOON, botUsername: 'agrotrace_bot' },
      },
    }),
    act: async (page) => {
      await page.getByRole('button', { name: 'Привязать Telegram' }).click();
    },
    ready: (p) => expect(p.getByRole('link', { name: 'Открыть Telegram' })).toBeVisible(),
  },
  {
    name: 'register-errors',
    path: '/register',
    signedIn: false,
    act: async (page) => {
      await page.getByRole('option', { name: 'Краснодарский край' }).waitFor({ state: 'attached' });
      await page.getByLabel('ИНН').fill('2311123456');
      await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    },
    ready: (p) => expect(p.getByLabel('ИНН')).toHaveAttribute('aria-invalid', 'true'),
  },
  {
    name: 'notifications',
    path: '/notifications',
    ready: (p) => expect(p.locator('.at-table-wrap tbody tr').first()).toBeVisible(),
  },
  {
    name: 'notifications-empty',
    path: '/notifications?tab=unread',
    overrides: async () => ({
      'GET /notifications': {
        status: 200,
        contentType: 'application/json',
        body: { items: [], page: 1, size: 20, total: 0 },
      },
    }),
    ready: (p) => expect(p.getByRole('button', { name: 'Все уведомления' })).toBeVisible(),
  },
  {
    name: 'notifications-failed',
    path: '/notifications',
    overrides: async () => ({
      'GET /notifications': {
        status: 403,
        contentType: 'application/problem+json',
        body: { type: '/problems/forbidden', title: 'Forbidden', status: 403, code: 'FORBIDDEN' },
      },
    }),
    ready: (p) => expect(p.getByText('Уведомления не загрузились.')).toBeVisible(),
  },
];

function canonical(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return `(no ${sel})`;
    const out: string[] = [];
    const walk = (n: Node, depth: number) => {
      const pad = '  '.repeat(depth);
      if (n.nodeType === Node.TEXT_NODE) {
        const s = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (s) out.push(`${pad}"${s}"`);
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const el = n as Element;
      const attrs = [...el.attributes]
        .map((a) => {
          let v = a.value;
          if (a.name === 'class')
            v = v
              .split(/\s+/)
              .filter((c) => c && !/^ng-/.test(c))
              .join(' ');
          if (a.name === 'style')
            v = v
              .split(';')
              .map((d) => d.trim().replace(/\s*:\s*/, ': '))
              .filter(Boolean)
              .join('; ');
          if (a.name === 'class' && v === '') return null;
          if (a.name === 'checked' && el.tagName === 'INPUT') return null;
          if (a.name === 'id' && el.classList.contains('at-file__hint')) return null;
          return `${a.name}="${v}"`;
        })
        .filter((a): a is string => a !== null)
        .sort();
      out.push(`${pad}<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
      el.childNodes.forEach((c) => walk(c, depth + 1));
    };
    walk(root, 0);
    return out.join('\n');
  }, selector);
}

async function render(page: Page, base: string, s: Screen): Promise<void> {
  await mockApi(page, { signedIn: s.signedIn ?? true, overrides: s.overrides ? await s.overrides() : {} });
  await page.goto(base + s.path);
  await s.act?.(page);
  await s.ready(page);
  await page.waitForTimeout(300);
}

let react: Browser;
const REACT = 'http://react-express.localhost:8089';

test.beforeAll(async () => {
  const host = (await lookup('host.docker.internal')).address;
  react = await chromium.launch({ args: [`--host-resolver-rules=MAP react-express.localhost ${host}`] });
});
test.afterAll(async () => {
  await react?.close();
});

for (const s of SCREENS) {
  test(`${s.name}: the page DOM equals React's; screenshots`, async ({ page, browser }) => {
    mkdirSync(SHOTS, { recursive: true });
    const reactContext = await react.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
    const rpage = await reactContext.newPage();
    const doms: string[] = [];
    for (const [front, p, base] of [
      ['angular', page, ''],
      ['react', rpage, REACT],
    ] as const) {
      await render(p, base, s);
      doms.push(await canonical(p, '.at-page:not([aria-busy])'));
      for (const width of [360, 1280])
        for (const scheme of ['light', 'dark'] as const) {
          await p.setViewportSize({ width, height: width === 360 ? 780 : 900 });
          await p.emulateMedia({ colorScheme: scheme });
          await p.waitForTimeout(150);
          await p.screenshot({
            path: `${SHOTS}/${front}-${s.name}-${width}-${scheme}.png`,
            fullPage: true,
            animations: 'disabled',
          });
          const overflow = await p.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, `${front} ${s.name} ${width}: horizontal scroll`).toBeLessThanOrEqual(0);
        }
      await p.setViewportSize({ width: 1280, height: 900 });
    }
    await reactContext.close();
    writeFileSync(`${SHOTS}/${s.name}.angular.txt`, doms[0]!);
    writeFileSync(`${SHOTS}/${s.name}.react.txt`, doms[1]!);
    void browser;
    expect(doms[0], `${s.name}: DOM differs (see ${SHOTS}/${s.name}.*.txt)`).toBe(doms[1]);
  });
}
