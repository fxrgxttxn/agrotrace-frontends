import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { File as NodeFile } from 'node:buffer';
import { formatLocalTime } from '@agrotrace/i18n';
import { server } from '../setup';
import { contractExample, contractResponse } from '../msw/fromContract';
import { renderApp } from '../app/renderApp';
import { expectNoLeakedInputs } from '../ui/leaks';

const me = () => contractExample('getMe').body as Record<string, unknown>;
const asMe = (patch: Record<string, unknown>) => contractResponse('getMe', { body: { ...me(), ...patch } });

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  type: `/problems/${code.toLowerCase().replace(/_/g, '-')}`,
  title: code,
  status,
  code,
  ...extra,
});

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

async function openProfile() {
  const utils = renderApp('/profile');
  await screen.findByRole('heading', { level: 1, name: 'Профиль' });
  return utils;
}

const card = (title: string) => screen.getByRole('heading', { level: 2, name: title }).closest('article')!;

const png = (bytes = 2048, type = 'image/png', name = 'me.png') =>
  new NodeFile([new Uint8Array(bytes)], name, { type }) as unknown as File;

const UndiciFormData = (
  await new Response('', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).formData()
).constructor as typeof FormData;
beforeEach(() => vi.stubGlobal('FormData', UndiciFormData));
afterEach(() => vi.unstubAllGlobals());

describe('personal data', () => {
  it('shows the profile and saves only what changed', async () => {
    let body: unknown;
    server.use(contractResponse('updateMe', { onRequest: async (r) => void (body = await r.json()) }));
    await openProfile();
    const personal = within(card('Личные данные'));
    expect(personal.getByLabelText('ФИО')).toHaveValue('Петров Иван Сергеевич');
    expect(personal.getByLabelText('Телефон')).toHaveValue('+79181234567');
    expect(personal.getByText('petrov@kfh-petrov.ru')).toBeInTheDocument();
    await userEvent.clear(personal.getByLabelText('Телефон'));
    await userEvent.type(personal.getByLabelText('Телефон'), '+79990001122');
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(politeText()).toBe('Профиль сохранён'));
    expect(body).toEqual({ phone: '+79990001122' });
    expectNoLeakedInputs(document.body);
  });

  it('an emptied phone is removed (`phone: null`)', async () => {
    let body: unknown;
    server.use(contractResponse('updateMe', { onRequest: async (r) => void (body = await r.json()) }));
    await openProfile();
    const personal = within(card('Личные данные'));
    await userEvent.clear(personal.getByLabelText('Телефон'));
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(body).toEqual({ phone: null }));
  });

  it('a phone in the wrong format is refused before the API', async () => {
    let called = false;
    server.use(contractResponse('updateMe', { onRequest: () => void (called = true) }));
    await openProfile();
    const personal = within(card('Личные данные'));
    await userEvent.clear(personal.getByLabelText('Телефон'));
    await userEvent.type(personal.getByLabelText('Телефон'), '8 918 123');
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    expect(personal.getByLabelText('Телефон')).toHaveAccessibleDescription('Недопустимый формат телефона');
    expect(called).toBe(false);
  });

  it('400 VALIDATION (contract example) goes under both fields', async () => {
    server.use(contractResponse('updateMe', { status: 400 }));
    await openProfile();
    const personal = within(card('Личные данные'));
    await userEvent.type(personal.getByLabelText('ФИО'), ' мл.');
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(personal.getByLabelText('ФИО')).toHaveAccessibleDescription('Обязательное поле'),
    );
    expect(personal.getByLabelText('Телефон')).toHaveAccessibleDescription('Недопустимый формат');
  });

  it('429: the save waits out Retry-After', async () => {
    server.use(contractResponse('updateMe', { status: 429, headers: { 'Retry-After': '9' } }));
    await openProfile();
    const personal = within(card('Личные данные'));
    await userEvent.type(personal.getByLabelText('ФИО'), 'а');
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    expect(await personal.findByRole('button', { name: 'Повторить через 9 с' })).toBeDisabled();
  });
});

describe('avatar', () => {
  it('previews the chosen image, uploads it as multipart `file`, reloads the profile', async () => {
    let contentType = '';
    let sent = '';
    let meCalls = 0;
    server.use(
      contractResponse('uploadMyAvatar', {
        onRequest: async (r) => {
          contentType = r.headers.get('Content-Type') ?? '';
          sent = await r.clone().text();
        },
      }),
      contractResponse('getMe', { onRequest: () => void meCalls++ }),
    );
    await openProfile();
    const avatar = within(card('Аватар'));
    await userEvent.upload(avatar.getByLabelText('Файл'), png());
    expect(avatar.getByText('me.png')).toBeInTheDocument();
    expect(avatar.getByText('2 КБ')).toBeInTheDocument();
    expect(avatar.getByText('me.png').closest('li')?.querySelector('img')?.getAttribute('src')).toMatch(
      /^blob:/,
    );
    const before = meCalls;
    await userEvent.click(avatar.getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(politeText()).toBe('Аватар обновлён'));
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(sent).toContain('name="file"; filename="me.png"\r\nContent-Type: image/png');
    expect(meCalls).toBeGreaterThan(before);
    expect(avatar.queryByText('me.png')).not.toBeInTheDocument();
  });

  it('a file over 2 МБ is refused before the upload', async () => {
    await openProfile();
    const avatar = within(card('Аватар'));
    await userEvent.upload(avatar.getByLabelText('Файл'), png(2097153));
    expect(avatar.getByLabelText('Файл')).toHaveAccessibleDescription(
      'Файл больше 2 МБ — выберите файл меньше',
    );
    expect(avatar.queryByRole('button', { name: 'Загрузить' })).not.toBeInTheDocument();
  });

  it('exactly 2 МБ is accepted (inclusive limit)', async () => {
    await openProfile();
    const avatar = within(card('Аватар'));
    await userEvent.upload(avatar.getByLabelText('Файл'), png(2097152));
    expect(avatar.getByRole('button', { name: 'Загрузить' })).toBeEnabled();
  });

  it('another file type is refused before the upload', async () => {
    await openProfile();
    const avatar = within(card('Аватар'));
    await userEvent.upload(avatar.getByLabelText('Файл'), png(100, 'image/gif', 'a.gif'), {
      applyAccept: false,
    });
    expect(avatar.getByLabelText('Файл')).toHaveAccessibleDescription(
      'Этот тип файла не подходит — выберите JPG, PNG, WebP',
    );
  });

  it.each([
    [413, {}, 'Файл больше 2 МБ — выберите файл меньше'],
    [415, {}, 'Этот тип файла не подходит — выберите JPG, PNG, WebP'],
    [
      400,
      { body: problem(400, 'VALIDATION', { errors: { file: ['validation.required'] } }) },
      'Обязательное поле',
    ],
  ])('server %s is shown on the file field', async (status, extra, text) => {
    server.use(contractResponse('uploadMyAvatar', { status, ...extra }));
    await openProfile();
    const avatar = within(card('Аватар'));
    await userEvent.upload(avatar.getByLabelText('Файл'), png());
    await userEvent.click(avatar.getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(avatar.getByLabelText('Файл')).toHaveAccessibleDescription(text));
  });

  it('upload 429 says when to retry', async () => {
    server.use(contractResponse('uploadMyAvatar', { status: 429, headers: { 'Retry-After': '12' } }));
    await openProfile();
    const avatar = within(card('Аватар'));
    await userEvent.upload(avatar.getByLabelText('Файл'), png());
    await userEvent.click(avatar.getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(politeText()).toBe('Слишком много попыток — повторите через 12 с'));
  });

  it.each([
    [403, {}, 'alert', 'Недостаточно прав для этого действия'],
    [429, { headers: { 'Retry-After': '3' } }, 'polite', 'Слишком много попыток — повторите через 3 с'],
  ])('removing: %s is shown, the avatar stays', async (status, extra, region, text) => {
    server.use(contractResponse('deleteMyAvatar', { status, ...extra }));
    await openProfile();
    const avatar = within(card('Аватар'));
    await userEvent.click(avatar.getByRole('button', { name: 'Удалить аватар' }));
    await waitFor(() => expect(region === 'alert' ? alertText() : politeText()).toBe(text));
    expect(avatar.getByRole('button', { name: 'Удалить аватар' })).toBeInTheDocument();
  });

  it('removes the current avatar', async () => {
    let deleted = false;
    server.use(contractResponse('deleteMyAvatar', { onRequest: () => void (deleted = true) }));
    await openProfile();
    const avatar = within(card('Аватар'));
    expect(avatar.getByRole('img', { name: 'Петров Иван Сергеевич' })).toHaveAttribute(
      'src',
      expect.stringContaining('variant=96'),
    );
    server.use(asMe({ avatarUrl: null }));
    await userEvent.click(avatar.getByRole('button', { name: 'Удалить аватар' }));
    await waitFor(() => expect(politeText()).toBe('Аватар удалён'));
    expect(deleted).toBe(true);
    expect(await avatar.findByRole('img', { name: 'Петров Иван Сергеевич' })).toHaveTextContent('ПИ');
    expect(avatar.queryByRole('button', { name: 'Удалить аватар' })).not.toBeInTheDocument();
  });
});

describe('notification channels', () => {
  it('switches reflect the settings and a toggle saves both channels', async () => {
    let body: unknown;
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: false, telegramLinked: true } }),
      contractResponse('updateMyChannels', {
        body: { email: false, telegram: false, telegramLinked: true },
        onRequest: async (r) => void (body = await r.json()),
      }),
    );
    await openProfile();
    const channels = within(card('Каналы уведомлений'));
    const email = await channels.findByRole('switch', { name: 'Email' });
    expect(email).toHaveAttribute('aria-checked', 'true');
    expect(channels.getByRole('switch', { name: 'Telegram' })).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(email);
    await waitFor(() => expect(email).toHaveAttribute('aria-checked', 'false'));
    expect(body).toEqual({ email: false, telegram: false });
  });

  it('Telegram cannot be switched on before it is linked; the link code names the bot and the expiry', async () => {
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: false, telegramLinked: false } }),
    );
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    server.use(
      contractResponse('createTelegramCode', {
        body: { code: 'K7M2Q9XA', expiresAt, botUsername: 'agrotrace_bot' },
      }),
    );
    await openProfile();
    const channels = within(card('Каналы уведомлений'));
    expect(await channels.findByRole('switch', { name: 'Telegram' })).toBeDisabled();
    await userEvent.click(channels.getByRole('button', { name: 'Привязать Telegram' }));
    expect(
      await channels.findByText('Отправьте боту @agrotrace_bot команду /start K7M2Q9XA'),
    ).toBeInTheDocument();
    expect(channels.getByText(`Код действует до ${formatLocalTime(expiresAt, 'ru')}`)).toBeInTheDocument();
    expect(channels.getByRole('link', { name: 'Открыть Telegram' })).toHaveAttribute(
      'href',
      'https://t.me/agrotrace_bot?start=K7M2Q9XA',
    );
  });

  it('at expiresAt the code disappears and polling stops; a new code can be asked for', async () => {
    let polls = 0;
    const expiresAt = new Date(Date.now() + 1500).toISOString().replace(/\.\d+Z$/, 'Z');
    server.use(
      contractResponse('getMyChannels', {
        body: { email: true, telegram: false, telegramLinked: false },
        onRequest: () => void polls++,
      }),
      contractResponse('createTelegramCode', {
        body: { code: 'K7M2Q9XA', expiresAt, botUsername: 'agrotrace_bot' },
      }),
    );
    await openProfile();
    const channels = within(card('Каналы уведомлений'));
    await userEvent.click(await channels.findByRole('button', { name: 'Привязать Telegram' }));
    await channels.findByText('Отправьте боту @agrotrace_bot команду /start K7M2Q9XA');
    expect(
      await channels.findByRole('button', { name: 'Привязать Telegram' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(channels.queryByText(/^Код действует до/)).not.toBeInTheDocument();
    const after = polls;
    await new Promise((r) => setTimeout(r, 5500));
    expect(polls).toBe(after);
  }, 15000);

  it('channels that fail to load show a message with a retry', async () => {
    server.use(contractResponse('getMyChannels', { status: 403, once: true }));
    await openProfile();
    const channels = within(card('Каналы уведомлений'));
    expect(await channels.findByText('Каналы уведомлений не загрузились.')).toBeInTheDocument();
    await userEvent.click(channels.getByRole('button', { name: 'Повторить' }));
    expect(await channels.findByRole('switch', { name: 'Email' })).toBeInTheDocument();
  });

  it('429 of a channel switch says when to retry', async () => {
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: false, telegramLinked: true } }),
      contractResponse('updateMyChannels', { status: 429, headers: { 'Retry-After': '8' } }),
    );
    await openProfile();
    await userEvent.click(await within(card('Каналы уведомлений')).findByRole('switch', { name: 'Email' }));
    await waitFor(() => expect(politeText()).toBe('Слишком много попыток — повторите через 8 с'));
  });

  it('429 of the link code says when to retry', async () => {
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: false, telegramLinked: false } }),
      contractResponse('createTelegramCode', { status: 429, headers: { 'Retry-After': '4' } }),
    );
    await openProfile();
    await userEvent.click(
      await within(card('Каналы уведомлений')).findByRole('button', { name: 'Привязать Telegram' }),
    );
    await waitFor(() => expect(politeText()).toBe('Слишком много попыток — повторите через 4 с'));
  });

  it('400 telegram.notLinked is shown as the form message', async () => {
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: false, telegramLinked: true } }),
      contractResponse('updateMyChannels', {
        status: 400,
        body: problem(400, 'VALIDATION', { errors: { telegram: ['validation.telegram.notLinked'] } }),
      }),
    );
    await openProfile();
    const channels = within(card('Каналы уведомлений'));
    await userEvent.click(await channels.findByRole('switch', { name: 'Telegram' }));
    await waitFor(() => expect(alertText()).toBe('Telegram не привязан'));
    expect(channels.getByRole('switch', { name: 'Telegram' })).toHaveAttribute('aria-checked', 'false');
  });

  it('503 of the link code: the bot is not configured', async () => {
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: false, telegramLinked: false } }),
      contractResponse('createTelegramCode', { status: 503 }),
    );
    await openProfile();
    const channels = within(card('Каналы уведомлений'));
    await userEvent.click(await channels.findByRole('button', { name: 'Привязать Telegram' }));
    await waitFor(() => expect(alertText()).toBe('Внешний сервис временно недоступен'));
  });
});

describe('two-factor authentication', () => {
  it('is not offered to roles other than INSPECTOR and ADMIN', async () => {
    await openProfile();
    expect(screen.queryByRole('heading', { name: 'Двухфакторная аутентификация' })).not.toBeInTheDocument();
  });

  it('setup: secret and a QR drawn from the otpauth URI, confirm with a code, then «on»', async () => {
    server.use(asMe({ roles: ['INSPECTOR'] }));
    const bodies: unknown[] = [];
    server.use(
      contractResponse('setupTwoFactor', {
        example: 'pending',
        once: true,
        onRequest: async (r) => void bodies.push(await r.json()),
      }),
      contractResponse('setupTwoFactor', {
        example: 'enabled',
        onRequest: async (r) => {
          bodies.push(await r.json());
          server.use(asMe({ roles: ['INSPECTOR'], totpEnabled: true }));
        },
      }),
    );
    await openProfile();
    const tfa = within(card('Двухфакторная аутентификация'));
    expect(tfa.getByText('Выключена')).toBeInTheDocument();
    await userEvent.click(tfa.getByRole('button', { name: 'Настроить' }));
    const qr = await tfa.findByRole('img', { name: 'QR-код для приложения-аутентификатора' });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    expect(tfa.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    expectNoLeakedInputs(document.body);
    await userEvent.type(tfa.getByLabelText('Код из приложения'), '482915');
    await userEvent.click(tfa.getByRole('button', { name: 'Включить' }));
    await waitFor(() => expect(politeText()).toBe('Двухфакторная аутентификация включена'));
    expect(bodies).toEqual([{}, { code: '482915' }]);
    expect(await tfa.findByText('Включена')).toBeInTheDocument();
    expect(tfa.queryByRole('img', { name: 'QR-код для приложения-аутентификатора' })).not.toBeInTheDocument();
  });

  it('400 INVALID_TWO_FACTOR_CODE goes under the code field', async () => {
    server.use(
      asMe({ roles: ['ADMIN'] }),
      contractResponse('setupTwoFactor', { example: 'pending', once: true }),
      contractResponse('setupTwoFactor', { status: 400, body: problem(400, 'INVALID_TWO_FACTOR_CODE') }),
    );
    await openProfile();
    const tfa = within(card('Двухфакторная аутентификация'));
    await userEvent.click(tfa.getByRole('button', { name: 'Настроить' }));
    await userEvent.type(await tfa.findByLabelText('Код из приложения'), '000000');
    await userEvent.click(tfa.getByRole('button', { name: 'Включить' }));
    await waitFor(() =>
      expect(tfa.getByLabelText('Код из приложения')).toHaveAccessibleDescription(
        'Неверный код двухфакторной аутентификации',
      ),
    );
  });

  it('409 (already on in another tab): the profile is reloaded and shows «on»', async () => {
    server.use(
      asMe({ roles: ['ADMIN'] }),
      contractResponse('setupTwoFactor', {
        status: 409,
        body: problem(409, 'INVALID_TRANSITION', { params: { from: 'ENABLED' } }),
        onRequest: () => void server.use(asMe({ roles: ['ADMIN'], totpEnabled: true })),
      }),
    );
    await openProfile();
    const tfa = within(card('Двухфакторная аутентификация'));
    await userEvent.click(tfa.getByRole('button', { name: 'Настроить' }));
    expect(await tfa.findByText('Включена')).toBeInTheDocument();
  });

  it.each([
    [400, {}, 'alert', 'Обязательное поле. Недопустимый формат'],
    [403, {}, 'alert', 'Недостаточно прав для этого действия'],
  ])('start step %s is shown as the message', async (status, extra, region, text) => {
    server.use(asMe({ roles: ['ADMIN'] }), contractResponse('setupTwoFactor', { status, ...extra }));
    await openProfile();
    const tfa = within(card('Двухфакторная аутентификация'));
    await userEvent.click(tfa.getByRole('button', { name: 'Настроить' }));
    await waitFor(() => expect(region === 'alert' ? alertText() : politeText()).toBe(text));
    expect(tfa.getByRole('button', { name: 'Настроить' })).toBeEnabled();
  });

  it('start step 429: the «Настроить» button counts down', async () => {
    server.use(
      asMe({ roles: ['ADMIN'] }),
      contractResponse('setupTwoFactor', { status: 429, headers: { 'Retry-After': '2' } }),
    );
    await openProfile();
    const tfa = within(card('Двухфакторная аутентификация'));
    await userEvent.click(tfa.getByRole('button', { name: 'Настроить' }));
    expect(await tfa.findByRole('button', { name: 'Повторить через 2 с' })).toBeDisabled();
    expect(politeText()).toBe('Слишком много попыток — повторите через 2 с');
    expect(await tfa.findByRole('button', { name: 'Настроить' }, { timeout: 3500 })).toBeEnabled();
  });

  it('a code that is not 6 digits is refused before the API', async () => {
    server.use(asMe({ roles: ['ADMIN'] }), contractResponse('setupTwoFactor', { example: 'pending' }));
    await openProfile();
    const tfa = within(card('Двухфакторная аутентификация'));
    await userEvent.click(tfa.getByRole('button', { name: 'Настроить' }));
    await userEvent.type(await tfa.findByLabelText('Код из приложения'), '12');
    await userEvent.click(tfa.getByRole('button', { name: 'Включить' }));
    expect(tfa.getByLabelText('Код из приложения')).toHaveAccessibleDescription(
      'Код должен состоять из 6 цифр',
    );
  });
});

describe('telegram link code (Angular)', () => {
  it('a code valid for longer than a timer can wait (2^31 ms) stays on screen', async () => {
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: false, telegramLinked: false } }),
      contractResponse('createTelegramCode', {
        body: { code: 'K7M2Q9XA', expiresAt: '2099-01-01T10:00:00Z', botUsername: 'agrotrace_bot' },
      }),
    );
    await openProfile();
    const channels = within(card('Каналы уведомлений'));
    await userEvent.click(await channels.findByRole('button', { name: 'Привязать Telegram' }));
    await channels.findByText('Отправьте боту @agrotrace_bot команду /start K7M2Q9XA');
    await new Promise((r) => setTimeout(r, 300));
    expect(channels.getByRole('link', { name: 'Открыть Telegram' })).toBeInTheDocument();
  });
});
