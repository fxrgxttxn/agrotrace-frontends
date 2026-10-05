import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ANONYMOUS, contractExample, mockApi, type Override } from './contract';

test.describe.configure({ mode: 'serial' });
test.setTimeout(300000);

const TOKEN = 'k3Jp9_Qw8Zr2Xy7Lm4Nb6Vc1Hd5Tf0Gs-Ae3Rt8Yu';
const SHOTS = 'test-results/shots/s2';
const SOON = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
const FRONTS = [
  ['svelte', ''],
  ['react', 'http://react-express.localhost:8089'],
  ['angular', 'http://angular-express.localhost:8090'],
] as const;

interface Screen {
  name: string;
  path: string;
  signedIn?: boolean;
  overrides?: Record<string, Override>;
  act?: (page: Page) => Promise<void>;
  ready: (page: Page) => Promise<void>;
}

const heading = (page: Page, name: string) =>
  expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
const me = () => contractExample('getMe').body as Record<string, unknown>;

const SCREENS: Screen[] = [
  { name: 'login', path: '/login', signedIn: false, ready: (p) => heading(p, 'Вход') },
  {
    name: 'login-2fa',
    path: '/login?next=%2Fbatches',
    signedIn: false,
    overrides: { login: { example: 'twoFactor' } },
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
    name: 'profile',
    path: '/profile',
    ready: (p) => expect(p.getByRole('switch', { name: 'Email' })).toBeVisible(),
  },
  {
    name: 'profile-2fa',
    path: '/profile',
    overrides: { getMe: { body: { ...me(), roles: ['INSPECTOR'] } }, setupTwoFactor: { example: 'pending' } },
    act: async (page) => {
      await page.getByRole('button', { name: 'Настроить' }).click();
    },
    ready: (p) => expect(p.getByRole('img', { name: 'QR-код для приложения-аутентификатора' })).toBeVisible(),
  },
  {
    name: 'profile-telegram-code',
    path: '/profile',
    overrides: {
      getMyChannels: { body: { email: true, telegram: false, telegramLinked: false } },
      createTelegramCode: { body: { code: 'K7M2Q9XA', expiresAt: SOON, botUsername: 'agrotrace_bot' } },
    },
    act: async (page) => {
      await page.getByRole('button', { name: 'Привязать Telegram' }).click();
    },
    ready: (p) => expect(p.getByRole('link', { name: 'Открыть Telegram' })).toBeVisible(),
  },
  {
    name: 'notifications',
    path: '/notifications',
    ready: (p) => expect(p.locator('.at-table-wrap tbody tr').first()).toBeVisible(),
  },
  {
    name: 'notifications-empty',
    path: '/notifications?tab=unread',
    overrides: { listNotifications: { body: { items: [], page: 1, size: 20, total: 0 } } },
    ready: (p) => expect(p.getByRole('button', { name: 'Все уведомления' })).toBeVisible(),
  },
  {
    name: 'notifications-failed',
    path: '/notifications',
    overrides: { listNotifications: { status: 403 } },
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
          if (a.name === 'class' && v === '') return null;
          if (a.name === 'style')
            v = v
              .split(';')
              .map((d) => d.trim().replace(/\s*:\s*/, ': '))
              .filter(Boolean)
              .join('; ');
          if (a.name === 'checked' && el.tagName === 'INPUT') return null;
          if (a.name === 'id' && el.classList.contains('at-file__hint')) return null;
          if (a.name === 'src' && el.tagName === 'IMG' && v.startsWith('blob:')) v = 'blob:';
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

async function up(browser: Browser, base: string): Promise<boolean> {
  const ctx = await browser.newContext();
  try {
    const res = await (await ctx.newPage()).goto(`${base}/p/probe`, { timeout: 5000 });
    return Boolean(res?.ok());
  } catch {
    return false;
  } finally {
    await ctx.close();
  }
}

for (const s of SCREENS)
  test(`S2 ${s.name}: the page DOM equals React's and Angular's; screenshots`, async ({ browser }) => {
    mkdirSync(SHOTS, { recursive: true });
    const doms: Record<string, string> = {};
    for (const [front, base] of FRONTS) {
      if (front !== 'svelte' && !(await up(browser, base))) continue;
      const context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
      await mockApi(context, { ...(s.signedIn === false ? ANONYMOUS : {}), ...s.overrides });
      const page = await context.newPage();
      await page.goto(base + s.path);
      await s.act?.(page);
      await s.ready(page);
      await page.waitForTimeout(300);
      doms[front] = await canonical(page, '.at-page:not([aria-busy])');
      for (const width of [360, 1280])
        for (const scheme of ['light', 'dark'] as const) {
          await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
          await page.emulateMedia({ colorScheme: scheme });
          await page.waitForTimeout(150);
          await page.screenshot({
            path: `${SHOTS}/${front}-${s.name}-${width}-${scheme}.png`,
            fullPage: true,
            animations: 'disabled',
          });
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, `${front} ${s.name} ${width}: horizontal scroll`).toBeLessThanOrEqual(0);
        }
      writeFileSync(`${SHOTS}/${s.name}.${front}.txt`, doms[front]!);
      await context.close();
    }
    test.info().annotations.push({ type: 'compared with', description: Object.keys(doms).join(', ') });
    for (const other of ['react', 'angular'])
      if (doms[other] !== undefined)
        expect(doms.svelte, `${s.name}: DOM differs from ${other} (see ${SHOTS}/${s.name}.*.txt)`).toBe(
          doms[other],
        );
  });
