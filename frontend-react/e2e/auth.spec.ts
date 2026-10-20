import { expect, request as playwrightRequest, test, type Page } from '@playwright/test';
import {
  annotateMissing,
  API,
  apiUp,
  cspViolations,
  currentStep,
  DEMO_PASSWORD,
  freshEmail,
  horizontalOverflow,
  mailToken,
  randomInn,
  signIn,
  signOut,
  totp,
  unexpected,
  watch,
} from './helpers';

// Task 2 against the live Express API through gateway-react: every demo role signs in; wrong credentials; a fresh
// employee (invited by the demo inspection head through the API) accepts the invitation, recovers the password through
// the Mailpit letter, sets up TOTP and signs in with the 2FA step; logout reaches every tab; screenshots of every
// screen at 360 / 1280 in both themes. Demo accounts are never changed (no wrong passwords, no 2FA on them).

const ROLES = [
  { role: 'FARMER', email: 'petrov@agrotrace.test', org: 'КФХ Петров И.С.' },
  { role: 'PROCESSOR', email: 'molkombinat.head@agrotrace.test', org: 'ООО «Молкомбинат Ставропольский»' },
  { role: 'LAB', email: 'vetlab.head@agrotrace.test', org: 'АНО «Ветеринарный испытательный центр Клязьма»' },
  { role: 'RETAILER', email: 'provizia.head@agrotrace.test', org: 'ООО «Торговый дом Провизия»' },
  {
    role: 'INSPECTOR',
    email: 'inspector@agrotrace.test',
    org: 'Инспекция агропродовольственного надзора Владимирского края',
  },
  { role: 'ADMIN', email: 'admin@agrotrace.test', org: 'ООО «АгроТрейс»' },
] as const;

const SHOTS = 'test-results/shots/task2';

async function shoot(page: Page, name: string, heading: string) {
  for (const width of [360, 1280])
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width === 360 ? 780 : 860 });
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await horizontalOverflow(page), `${name} ${width} ${scheme}`).toBeLessThanOrEqual(0);
      // transitions of the theme switch are finished first (a mid-transition frame looks washed out)
      await page.screenshot({
        path: `${SHOTS}/${name}-${width}-${scheme}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.emulateMedia({ colorScheme: 'light' });
}

test.describe('with the live API', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await apiUp(page)), 'api-express is not up on the shared stack (./at up express)');
  });

  for (const r of ROLES)
    test(`${r.role} demo user signs in and out`, async ({ page }) => {
      const w = await watch(page);
      await page.goto('/login');
      await signIn(page, r.email, DEMO_PASSWORD);
      await expect(page.getByRole('heading', { level: 1, name: 'Панель' })).toBeVisible();
      await expect(page.locator('.at-topbar__org-name')).toHaveText(r.org);
      await signOut(page);
      expect(await cspViolations(page)).toEqual([]);
      annotateMissing(w);
      expect(unexpected(w)).toEqual([]);
    });

  test('an unknown email or a wrong password: one message, the form stays', async ({ page }) => {
    const w = await watch(page);
    await page.goto('/login');
    await signIn(page, freshEmail('nobody'), 'wrong-password-1');
    await expect(page.locator('.at-toast-region[role="alert"] .at-toast__text')).toHaveText(
      'Неверный email или пароль',
    );
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('Email')).toBeVisible();
    expect(unexpected(w, [/^http 401 POST \/api\/v1\/auth\/login$/])).toEqual([]);
  });

  test('client checks stop the request (no API call for an invalid email)', async ({ page }) => {
    let calls = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/v1/auth/login')) calls++;
    });
    await page.goto('/login');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByLabel('Email')).toHaveAccessibleDescription('Некорректный email');
    expect(calls).toBe(0);
  });

  test('logout in one tab signs out every tab', async ({ browser }) => {
    const context = await browser.newContext();
    const one = await context.newPage();
    const two = await context.newPage();
    await one.goto('/login');
    await signIn(one, 'provizia.head@agrotrace.test', DEMO_PASSWORD);
    await expect(one.getByRole('heading', { level: 1, name: 'Панель' })).toBeVisible();
    await two.goto('/batches');
    await expect(two.getByRole('heading', { level: 1, name: 'Партии' })).toBeVisible();
    await one.goto('/profile');
    await one.getByRole('button', { name: 'Выйти' }).click();
    await expect(one.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
    await expect(two.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
    // and the cookie is gone: a reload of the second tab stays signed out
    await two.goto('/batches');
    await expect(two.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
    await context.close();
  });

  test.describe.serial('a fresh employee: invitation, password recovery, 2FA', () => {
    const email = freshEmail('inspector');
    const fullName = 'Проверкина Ева Тестовна';
    let password = 'first-password-2026';
    let secret = '';
    let setupStep = 0;

    test('the inspection head invites; the letter link opens /invite/:token; accept', async ({ page }) => {
      const api = await playwrightRequest.newContext();
      const login = await api.post(`${API}/auth/login`, {
        data: { email: 'inspector.head@agrotrace.test', password: DEMO_PASSWORD },
      });
      expect(login.status(), await login.text()).toBe(200);
      const { accessToken } = (await login.json()) as { accessToken: string };
      const invite = await api.post(`${API}/users`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        data: { email, fullName: 'Приглашённый', roles: ['INSPECTOR'], isOrgAdmin: false },
      });
      expect(invite.status(), await invite.text()).toBe(201);
      const token = await mailToken(api, email, /\/invite\/([A-Za-z0-9_-]+)/);
      await api.dispose();

      const w = await watch(page);
      await page.goto(`/invite/${token}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Приглашение' })).toBeVisible();
      await shoot(page, 'invite', 'Приглашение');
      await page.getByLabel('ФИО').fill(fullName);
      await page.getByLabel('Пароль').fill(password);
      await page.getByRole('button', { name: 'Принять приглашение' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
      await expect(page.locator('.at-toast-region[aria-live] .at-toast__text')).toHaveText(
        'Приглашение принято — войдите',
      );
      // the same link again is dead
      await page.goto(`/invite/${token}`);
      await page.getByLabel('ФИО').fill(fullName);
      await page.getByLabel('Пароль').fill(password);
      await page.getByRole('button', { name: 'Принять приглашение' }).click();
      await expect(page.getByText('Приглашение устарело или уже принято.')).toBeVisible();
      expect(unexpected(w, [/^http 400 POST \/api\/v1\/auth\/accept-invite$/])).toEqual([]);
    });

    test('a wrong password, then forgot → Mailpit link → reset → sign in with the new one', async ({
      page,
      request,
    }) => {
      const w = await watch(page);
      await page.goto('/login');
      await signIn(page, email, 'not-my-password-1');
      await expect(page.locator('.at-toast-region[role="alert"] .at-toast__text')).toHaveText(
        'Неверный email или пароль',
      );

      await page.getByRole('link', { name: 'Забыли пароль?' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Восстановление пароля' })).toBeVisible();
      await shoot(page, 'forgot', 'Восстановление пароля');
      await page.getByLabel('Email').fill(email);
      await page.getByRole('button', { name: 'Отправить ссылку' }).click();
      await expect(page.getByText(`Если адрес ${email} зарегистрирован`)).toBeVisible();
      await shoot(page, 'forgot-sent', 'Восстановление пароля');

      const token = await mailToken(request, email, /\/password\/reset\/([A-Za-z0-9_-]+)/);
      password = 'second-password-2026';
      await page.goto(`/password/reset/${token}`);
      await shoot(page, 'reset', 'Новый пароль');
      await page.getByLabel('Новый пароль').fill(password);
      await page.getByRole('button', { name: 'Сохранить пароль' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
      await expect(page.locator('.at-toast-region[aria-live] .at-toast__text')).toHaveText(
        'Пароль изменён — войдите с новым паролем',
      );
      await signIn(page, email, password);
      await expect(page.getByRole('heading', { level: 1, name: 'Панель' })).toBeVisible();
      annotateMissing(w);
      expect(unexpected(w, [/^http 401 POST \/api\/v1\/auth\/login$/])).toEqual([]);
    });

    test('2FA: set up in the profile (QR + key), then the login asks for the code', async ({ page }) => {
      const w = await watch(page);
      await page.goto('/login');
      await signIn(page, email, password);
      await expect(page.getByRole('heading', { level: 1, name: 'Панель' })).toBeVisible();
      await page.goto('/profile');
      const card = page.locator('article', {
        has: page.getByRole('heading', { name: 'Двухфакторная аутентификация' }),
      });
      await expect(card.getByText('Выключена')).toBeVisible();
      await card.getByRole('button', { name: 'Настроить' }).click();
      await expect(card.getByRole('img', { name: 'QR-код для приложения-аутентификатора' })).toBeVisible();
      secret = ((await card.locator('.at-mono').first().textContent()) ?? '').replace(/\s+/g, '');
      expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
      await shoot(page, 'profile-2fa-setup', 'Профиль');
      await card.getByLabel('Код из приложения').fill('000000');
      await card.getByRole('button', { name: 'Включить' }).click();
      await expect(card.getByLabel('Код из приложения')).toHaveAccessibleDescription(
        'Неверный код двухфакторной аутентификации',
      );
      setupStep = currentStep();
      await card.getByLabel('Код из приложения').fill(totp(secret, setupStep));
      await card.getByRole('button', { name: 'Включить' }).click();
      await expect(card.getByText('Включена')).toBeVisible();
      await signOut(page);

      await signIn(page, email, password);
      await expect(page.getByRole('heading', { level: 1, name: 'Код подтверждения' })).toBeVisible();
      await expect(page).toHaveURL(/\/login\/2fa$/);
      await shoot(page, 'two-factor', 'Код подтверждения');
      await page.getByLabel('Код из приложения').fill('000000');
      await page.getByRole('button', { name: 'Подтвердить' }).click();
      await expect(page.getByLabel('Код из приложения')).toHaveAccessibleDescription(
        /^Неверный код\. Осталось попыток: \d$/,
      );
      // the step accepted at setup is never accepted again (R35): the next one, within the ±1 window
      await page.getByLabel('Код из приложения').fill(totp(secret, Math.max(setupStep + 1, currentStep())));
      await page.getByRole('button', { name: 'Подтвердить' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Панель' })).toBeVisible();
      await expect(page.locator('.at-topbar__org-name')).toHaveText(
        'Инспекция агропродовольственного надзора Владимирского края',
      );
      annotateMissing(w);
      expect(
        unexpected(w, [
          /^http 400 POST \/api\/v1\/auth\/2fa\/setup$/,
          /^http 401 POST \/api\/v1\/auth\/2fa\/verify$/,
        ]),
      ).toEqual([]);
    });
  });

  test('registration of a fresh organization (skipped while the backend has no public regions)', async ({
    page,
  }) => {
    const w = await watch(page);
    await page.goto('/register');
    await expect(page.getByRole('heading', { level: 1, name: 'Регистрация организации' })).toBeVisible();
    const regions = await page.evaluate(async () => (await fetch('/api/v1/public/regions')).status);
    test.skip(regions === 404, 'GET /public/regions is not served by the backend yet');
    await page.getByLabel('ИНН').fill(randomInn());
    await page.getByLabel('Тип организации').selectOption('RETAILER');
    await page.getByLabel('Название').fill('ООО «Проверка e2e»');
    await page.getByLabel('Регион').selectOption({ index: 1 });
    await page.getByLabel('Email').fill(freshEmail('head'));
    await page.getByLabel('ФИО').fill('Тестов Тест Тестович');
    await page.getByLabel('Пароль').fill('register-pass-2026');
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(page.getByText(/^Заявка отправлена\./)).toBeVisible({ timeout: 20000 });
    expect(unexpected(w)).toEqual([]);
  });

  test('screenshots of the guest screens and the cabinet screens of this task', async ({ page }) => {
    await page.goto('/login');
    await shoot(page, 'login', 'Вход');
    await page.goto('/password/forgot');
    await shoot(page, 'forgot-form', 'Восстановление пароля');
    await page.goto('/password/reset/0123456789abcdef0123');
    await shoot(page, 'reset-form', 'Новый пароль');
    await page.goto('/password/reset/dead');
    await shoot(page, 'reset-dead', 'Новый пароль');
    await page.goto('/register');
    await shoot(page, 'register', 'Регистрация организации');
    await page.goto('/nowhere');
    await shoot(page, 'not-found-guest', 'Страница не найдена');

    await page.goto('/login');
    await signIn(page, 'petrov@agrotrace.test', DEMO_PASSWORD);
    await expect(page.getByRole('heading', { level: 1, name: 'Панель' })).toBeVisible();
    await page.goto('/profile');
    await shoot(page, 'profile', 'Профиль');
    await page.goto('/notifications');
    await shoot(page, 'notifications', 'Уведомления');
    await page.goto('/admin/users');
    await shoot(page, 'forbidden', 'Нет доступа');
    await page.goto('/nowhere');
    await shoot(page, 'not-found', 'Страница не найдена');
    await page.goto('/invite/0123456789abcdef0123');
    await shoot(page, 'invite-signed-in', 'Приглашение');
    await signOut(page);
  });
});
