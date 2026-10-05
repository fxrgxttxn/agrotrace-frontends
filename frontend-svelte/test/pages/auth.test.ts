import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { formatLocalTime } from '@agrotrace/i18n';
import { server } from '../setup';
import { API_BASE, contractResponse } from '../msw/fromContract';
import { renderApp } from '../app/renderApp';

const guest = () => server.use(contractResponse('refreshToken', { status: 401 }));

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  type: `/problems/${code.toLowerCase().replace(/_/g, '-')}`,
  title: code,
  status,
  code,
  ...extra,
});

async function jsonOf(r: Request): Promise<Record<string, unknown>> {
  return (await r.clone().json()) as Record<string, unknown>;
}

function alertText(): string {
  return [...document.querySelectorAll('.at-toast-region[role="alert"] .at-toast__text')]
    .map((n) => n.textContent)
    .join('|');
}
function politeText(): string {
  return [...document.querySelectorAll('.at-toast-region[aria-live] .at-toast__text')]
    .map((n) => n.textContent)
    .join('|');
}

async function openLogin(path = '/login') {
  const utils = await renderApp(path);
  await screen.findByRole('heading', { level: 1, name: 'Вход' });
  return utils;
}

async function fillLogin(email = 'petrov@kfh-petrov.ru', password = 'agrotrace-demo') {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Пароль'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
}

describe('/login', () => {
  it('sends the typed email and password as they are and signs in', async () => {
    guest();
    let body: Record<string, unknown> = {};
    server.use(contractResponse('login', { onRequest: async (r) => void (body = await jsonOf(r)) }));
    await openLogin('/login?next=%2Ffields');
    await fillLogin('Petrov@KFH-petrov.ru', ' pass word 12 ');
    expect(await screen.findByRole('heading', { level: 1, name: 'Поля' })).toBeInTheDocument();
    expect(body).toEqual({ email: 'Petrov@KFH-petrov.ru', password: ' pass word 12 ' });
    expect(location.pathname).toBe('/fields');
  });

  it('checks the form with the shared schema before calling the API', async () => {
    guest();
    let called = false;
    server.use(contractResponse('login', { onRequest: () => void (called = true) }));
    await openLogin();
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Некорректный email');
    expect(screen.getByLabelText('Пароль')).toHaveAccessibleDescription('Обязательное поле');
    expect(called).toBe(false);
  });

  it('400 VALIDATION: field errors under the fields, `_root` as the form message', async () => {
    guest();
    server.use(
      contractResponse('login', {
        status: 400,
        body: problem(400, 'VALIDATION', {
          errors: { email: ['validation.email'], _root: ['validation.invalid'] },
        }),
      }),
    );
    await openLogin();
    await fillLogin();
    await waitFor(() =>
      expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Некорректный email'),
    );
    expect(alertText()).toBe('Недопустимое значение');
  });

  it('401 INVALID_CREDENTIALS: one error message, replaced (not stacked) on the next try', async () => {
    guest();
    server.use(contractResponse('login', { status: 401, example: 'invalidCredentials' }));
    await openLogin();
    await fillLogin();
    await waitFor(() => expect(alertText()).toBe('Неверный email или пароль'));
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await waitFor(() => expect(alertText()).toBe('Неверный email или пароль'));
  });

  it('401 ACCOUNT_LOCKED: says until when (local time)', async () => {
    guest();
    server.use(contractResponse('login', { status: 401, example: 'accountLocked' }));
    await openLogin();
    await fillLogin();
    const time = formatLocalTime('2026-09-24T08:45:00Z', 'ru');
    await waitFor(() =>
      expect(alertText()).toBe(`Вход заблокирован до ${time}: слишком много неверных паролей`),
    );
  });

  it.each([
    ['USER_BLOCKED', 'Учётная запись заблокирована — обратитесь к руководителю организации'],
    ['USER_INVITED', 'Приглашение не принято — задайте пароль по ссылке из письма'],
    ['ORGANIZATION_NOT_ACTIVE', 'Организация ещё не активна — вход откроется после её проверки'],
  ])('403 FORBIDDEN reason %s', async (reason, text) => {
    guest();
    server.use(
      contractResponse('login', { status: 403, body: problem(403, 'FORBIDDEN', { params: { reason } }) }),
    );
    await openLogin();
    await fillLogin();
    await waitFor(() => expect(alertText()).toBe(text));
  });

  it('429: the submit waits out Retry-After with a countdown', async () => {
    guest();
    server.use(contractResponse('login', { status: 429, headers: { 'Retry-After': '2' } }));
    await openLogin();
    await fillLogin();
    const wait = await screen.findByRole('button', { name: 'Повторить через 2 с' });
    expect(wait).toBeDisabled();
    expect(politeText()).toBe('Слишком много попыток — повторите через 2 с');
    expect(await screen.findByRole('button', { name: 'Войти' }, { timeout: 3500 })).toBeEnabled();
  });

  it('a network failure is a «service unavailable» message', async () => {
    guest();
    server.use(http.post(`${API_BASE}/auth/login`, () => HttpResponse.error()));
    await openLogin();
    await fillLogin();
    await waitFor(() => expect(alertText()).toBe('Сервис временно недоступен'));
  });

  it('links to password recovery and registration', async () => {
    guest();
    await openLogin();
    expect(screen.getByRole('link', { name: 'Забыли пароль?' })).toHaveAttribute('href', '/password/forgot');
    expect(screen.getByRole('link', { name: 'Регистрация организации' })).toHaveAttribute(
      'href',
      '/register',
    );
  });
});

async function toTwoFactor(path = '/login?next=%2Fbatches') {
  guest();
  server.use(contractResponse('login', { example: 'twoFactor' }));
  const utils = await openLogin(path);
  await fillLogin();
  await screen.findByRole('heading', { level: 1, name: 'Код подтверждения' });
  return utils;
}

describe('/login/2fa', () => {
  it('without a challenge goes back to /login', async () => {
    guest();
    await renderApp('/login/2fa');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(location.pathname).toBe('/login');
  });

  it('sends the challenge with the code and continues to `next`', async () => {
    let body: Record<string, unknown> = {};
    server.use(
      contractResponse('verifyTwoFactor', { onRequest: async (r) => void (body = await jsonOf(r)) }),
    );
    await toTwoFactor();
    await userEvent.type(screen.getByLabelText('Код из приложения'), '482915');
    await userEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Партии' })).toBeInTheDocument();
    expect(body).toEqual({ challengeId: 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f', code: '482915' });
    expect(location.pathname).toBe('/batches');
  });

  it('a code that is not 6 digits is refused before the API', async () => {
    let called = false;
    server.use(contractResponse('verifyTwoFactor', { onRequest: () => void (called = true) }));
    await toTwoFactor();
    await userEvent.type(screen.getByLabelText('Код из приложения'), '12a');
    await userEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect(screen.getByLabelText('Код из приложения')).toHaveAccessibleDescription(
      'Код должен состоять из 6 цифр',
    );
    expect(called).toBe(false);
  });

  it('401 INVALID_TWO_FACTOR_CODE: attempts left under the field', async () => {
    server.use(contractResponse('verifyTwoFactor', { status: 401, example: 'invalidCode' }));
    await toTwoFactor();
    await userEvent.type(screen.getByLabelText('Код из приложения'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Код из приложения')).toHaveAccessibleDescription(
        'Неверный код. Осталось попыток: 3',
      ),
    );
  });

  it('the last wrong code (attemptsLeft 0) ends the challenge: back to /login, `next` kept', async () => {
    server.use(
      contractResponse('verifyTwoFactor', {
        status: 401,
        body: problem(401, 'INVALID_TWO_FACTOR_CODE', { params: { attemptsLeft: 0 } }),
      }),
    );
    await toTwoFactor();
    await userEvent.type(screen.getByLabelText('Код из приложения'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(location.search).toBe('?next=%2Fbatches');
    expect(alertText()).toBe('Время на ввод кода истекло — войдите снова');
  });

  it('401 TOKEN_EXPIRED (challenge expired): back to /login with the message', async () => {
    server.use(contractResponse('verifyTwoFactor', { status: 401, example: 'challengeExpired' }));
    await toTwoFactor();
    await userEvent.type(screen.getByLabelText('Код из приложения'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(alertText()).toBe('Время на ввод кода истекло — войдите снова');
  });

  it('400 VALIDATION on the code goes under the field', async () => {
    server.use(
      contractResponse('verifyTwoFactor', {
        status: 400,
        body: problem(400, 'VALIDATION', { errors: { code: ['validation.totp.format'] } }),
      }),
    );
    await toTwoFactor();
    await userEvent.type(screen.getByLabelText('Код из приложения'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Код из приложения')).toHaveAccessibleDescription(
        'Код должен состоять из 6 цифр',
      ),
    );
  });
});

describe('/password/forgot', () => {
  async function open() {
    guest();
    const utils = await renderApp('/password/forgot');
    await screen.findByRole('heading', { level: 1, name: 'Восстановление пароля' });
    return utils;
  }

  it('always answers with the same message (no account enumeration)', async () => {
    let body: Record<string, unknown> = {};
    server.use(contractResponse('forgotPassword', { onRequest: async (r) => void (body = await jsonOf(r)) }));
    await open();
    await userEvent.type(screen.getByLabelText('Email'), 'nobody@example.org');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить ссылку' }));
    expect(
      await screen.findByText(
        'Если адрес nobody@example.org зарегистрирован, на него придёт письмо со ссылкой. Ссылка действует 1 час.',
      ),
    ).toBeInTheDocument();
    expect(body).toEqual({ email: 'nobody@example.org' });
    expect(screen.getByRole('link', { name: 'Ко входу' })).toHaveAttribute('href', '/login');
  });

  it('400 VALIDATION under the email field', async () => {
    server.use(
      contractResponse('forgotPassword', {
        status: 400,
        body: problem(400, 'VALIDATION', { errors: { email: ['validation.maxLength'] } }),
      }),
    );
    await open();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.ru');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить ссылку' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Слишком длинное значение'),
    );
  });

  it('429: countdown on the submit', async () => {
    server.use(contractResponse('forgotPassword', { status: 429, headers: { 'Retry-After': '30' } }));
    await open();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.ru');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить ссылку' }));
    expect(await screen.findByRole('button', { name: 'Повторить через 30 с' })).toBeDisabled();
  });
});

const TOKEN = 'k3Jp9_Qw8Zr2Xy7Lm4Nb6Vc1Hd5Tf0Gs-Ae3Rt8Yu';

describe('/password/reset/:token', () => {
  async function open() {
    guest();
    const utils = await renderApp(`/password/reset/${TOKEN}`);
    await screen.findByRole('heading', { level: 1, name: 'Новый пароль' });
    return utils;
  }

  it('sets the password with the token from the URL, then the login screen says so', async () => {
    let body: Record<string, unknown> = {};
    server.use(contractResponse('resetPassword', { onRequest: async (r) => void (body = await jsonOf(r)) }));
    await open();
    await userEvent.type(screen.getByLabelText('Новый пароль'), 'new-password-2026');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' }));
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(body).toEqual({ token: TOKEN, password: 'new-password-2026' });
    expect(location.pathname).toBe('/login');
    expect(politeText()).toBe('Пароль изменён — войдите с новым паролем');
  });

  it('a password shorter than 10 characters is refused before the API', async () => {
    await open();
    await userEvent.type(screen.getByLabelText('Новый пароль'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' }));
    expect(screen.getByLabelText('Новый пароль')).toHaveAccessibleDescription(
      'Пароль должен быть не короче 10 символов',
    );
  });

  it('400 TOKEN_EXPIRED: the link is dead, offers a new one', async () => {
    server.use(contractResponse('resetPassword', { status: 400, body: problem(400, 'TOKEN_EXPIRED') }));
    await open();
    await userEvent.type(screen.getByLabelText('Новый пароль'), 'new-password-2026');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' }));
    expect(await screen.findByText('Ссылка устарела или уже использована.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Запросить новую ссылку' })).toHaveAttribute(
      'href',
      '/password/forgot',
    );
    expect(screen.queryByLabelText('Новый пароль')).not.toBeInTheDocument();
  });

  it('400 VALIDATION on the password under the field', async () => {
    server.use(
      contractResponse('resetPassword', {
        status: 400,
        body: problem(400, 'VALIDATION', { errors: { password: ['validation.password.max'] } }),
      }),
    );
    await open();
    await userEvent.type(screen.getByLabelText('Новый пароль'), 'new-password-2026');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Новый пароль')).toHaveAccessibleDescription(
        'Пароль не может быть длиннее 128 символов',
      ),
    );
  });

  it('a token of impossible length is dead without calling the API', async () => {
    guest();
    await renderApp('/password/reset/short');
    expect(await screen.findByText('Ссылка устарела или уже использована.')).toBeInTheDocument();
  });
});

describe('/invite/:token', () => {
  it('signed in as someone else: says so and offers to sign out, staying on the link', async () => {
    await renderApp(`/invite/${TOKEN}`);
    expect(
      await screen.findByText(
        'Вы вошли как Петров Иван Сергеевич. Приглашение — для другой учётной записи: выйдите, чтобы принять его.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('ФИО')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(await screen.findByLabelText('ФИО')).toBeInTheDocument();
    expect(location.pathname).toBe(`/invite/${TOKEN}`);
    expect(alertText() + politeText()).toBe('');
  });

  async function open() {
    guest();
    const utils = await renderApp(`/invite/${TOKEN}`);
    await screen.findByRole('heading', { level: 1, name: 'Приглашение' });
    return utils;
  }

  it('accepts with the full name and password, then the login screen says so', async () => {
    let body: Record<string, unknown> = {};
    server.use(contractResponse('acceptInvite', { onRequest: async (r) => void (body = await jsonOf(r)) }));
    await open();
    await userEvent.type(screen.getByLabelText('ФИО'), 'Сидорова Анна Викторовна');
    await userEvent.type(screen.getByLabelText('Пароль'), 'invite-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Принять приглашение' }));
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(body).toEqual({
      token: TOKEN,
      fullName: 'Сидорова Анна Викторовна',
      password: 'invite-password-1',
    });
    expect(location.pathname).toBe('/login');
    expect(politeText()).toBe('Приглашение принято — войдите');
  });

  it('a whitespace-only name is refused (NameString), not trimmed', async () => {
    await open();
    await userEvent.type(screen.getByLabelText('ФИО'), '   ');
    await userEvent.type(screen.getByLabelText('Пароль'), 'invite-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Принять приглашение' }));
    expect(screen.getByLabelText('ФИО')).toHaveAccessibleDescription('Недопустимый формат');
  });

  it('400 TOKEN_EXPIRED: the invitation is dead', async () => {
    server.use(contractResponse('acceptInvite', { status: 400, body: problem(400, 'TOKEN_EXPIRED') }));
    await open();
    await userEvent.type(screen.getByLabelText('ФИО'), 'Анна');
    await userEvent.type(screen.getByLabelText('Пароль'), 'invite-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Принять приглашение' }));
    expect(await screen.findByText('Приглашение устарело или уже принято.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ко входу' })).toHaveAttribute('href', '/login');
  });

  it('400 VALIDATION (contract example) goes under the fields', async () => {
    server.use(contractResponse('acceptInvite', { status: 400 }));
    await open();
    await userEvent.type(screen.getByLabelText('ФИО'), 'Анна');
    await userEvent.type(screen.getByLabelText('Пароль'), 'invite-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Принять приглашение' }));
    await waitFor(() =>
      expect(screen.getByLabelText('ФИО')).toHaveAccessibleDescription('Обязательное поле'),
    );
    expect(alertText()).toBe('Недопустимый формат');
  });
});

describe('/register', () => {
  const VALID_INN = '2311123457';

  async function open() {
    guest();
    const utils = await renderApp('/register');
    await screen.findByRole('heading', { level: 1, name: 'Регистрация организации' });
    await screen.findByRole('option', { name: 'Краснодарский край' });
    return utils;
  }

  async function fill(inn = VALID_INN) {
    await userEvent.type(screen.getByLabelText('ИНН'), inn);
    await userEvent.selectOptions(screen.getByLabelText('Тип организации'), 'FARM');
    await userEvent.selectOptions(screen.getByLabelText('Регион'), '23');
    await userEvent.type(screen.getByLabelText('Email'), 'head@farm.ru');
    await userEvent.type(screen.getByLabelText('ФИО'), 'Петров Иван');
    await userEvent.type(screen.getByLabelText('Пароль'), 'register-pass-1');
    await userEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
  }

  it('regions come from the public dictionary', async () => {
    await open();
    const options = within(screen.getByLabelText('Регион'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Выберите регион', 'Владимирская область', 'Краснодарский край']);
  });

  it('sends the organization and its head; PENDING → «application sent»', async () => {
    let body: Record<string, unknown> = {};
    server.use(
      contractResponse('registerOrganization', { onRequest: async (r) => void (body = await jsonOf(r)) }),
    );
    await open();
    await fill();
    expect(
      await screen.findByText('Заявка отправлена. Вход откроется, когда администратор проверит организацию.'),
    ).toBeInTheDocument();
    expect(body).toEqual({
      inn: VALID_INN,
      type: 'FARM',
      regionCode: '23',
      admin: { email: 'head@farm.ru', fullName: 'Петров Иван', password: 'register-pass-1' },
    });
  });

  it('MANUAL_CHECK outcome says the organization is checked by hand', async () => {
    server.use(contractResponse('registerOrganization', { example: 'manualCheck' }));
    await open();
    await userEvent.type(screen.getByLabelText('Название'), 'КФХ Иванов');
    await fill();
    expect(
      await screen.findByText(
        'Заявка отправлена. ИНН не удалось проверить автоматически — организацию проверят вручную.',
      ),
    ).toBeInTheDocument();
  });

  it('the INN checksum is checked on the client (R66)', async () => {
    let called = false;
    server.use(contractResponse('registerOrganization', { onRequest: () => void (called = true) }));
    await open();
    await fill('2311123456');
    expect(screen.getByLabelText('ИНН')).toHaveAccessibleDescription('Некорректный ИНН (контрольная сумма)');
    expect(called).toBe(false);
  });

  it('a region must be chosen', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
    expect(screen.getByLabelText('Регион')).toHaveAccessibleDescription('Обязательное поле');
  });

  it('400 VALIDATION: taken INN and head email go under their fields', async () => {
    server.use(
      contractResponse('registerOrganization', {
        status: 400,
        body: problem(400, 'VALIDATION', {
          errors: { 'admin.email': ['validation.email.taken'], inn: ['validation.inn.taken'] },
        }),
      }),
    );
    await open();
    await fill();
    await waitFor(() =>
      expect(screen.getByLabelText('ИНН')).toHaveAccessibleDescription('ИНН уже зарегистрирован'),
    );
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Email уже зарегистрирован');
    expect(document.activeElement).toBe(screen.getByLabelText('ИНН'));
  });

  it('regions that fail to load can be retried', async () => {
    guest();
    let fail = true;
    server.use(
      http.get(`${API_BASE}/public/regions`, () =>
        fail ? new HttpResponse(null, { status: 503 }) : undefined,
      ),
    );
    await renderApp('/register');
    const retry = await screen.findByRole('button', { name: 'Повторить' }, { timeout: 8000 });
    expect(screen.getByText('Регионы не загрузились — повторите')).toBeInTheDocument();
    expect(screen.getByLabelText('Регион')).not.toHaveAttribute('aria-invalid');
    fail = false;
    await userEvent.click(retry);
    expect(await screen.findByRole('option', { name: 'Краснодарский край' })).toBeInTheDocument();
  });
});
