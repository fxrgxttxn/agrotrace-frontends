import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { renderApp } from '../app/renderApp';
import { cache } from '../../src/lib/app/cache.svelte';

const me = () => contractExample('getMe').body as Record<string, unknown>;
const asMe = (patch: Record<string, unknown>) => contractResponse('getMe', { body: { ...me(), ...patch } });
const hex = (n: number) => n.toString(16).padStart(12, '0');
const note = (seq: number, isRead = false) => ({
  id: `b7c8d9e0-f1a2-4b3c-8d4e-${hex(seq)}`,
  seq,
  type: 'RECALL_TASK',
  payload: {
    recallId: '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d',
    taskId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
    batchId: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f',
    publicCode: `AT-2026-${String(seq).padStart(6, '0')}`,
    dueAt: '2026-09-25T15:00:00Z',
    event: 'CREATED',
  },
  isRead,
  createdAt: '2026-09-24T09:00:12Z',
});
const pageOf = (items: unknown[], total = items.length, page = 1) => ({ items, page, size: 20, total });
const h1 = (name: string) => screen.getByRole('heading', { level: 1, name });
const problem400Code = () => ({
  type: '/problems/invalid-two-factor-code',
  title: 'INVALID_TWO_FACTOR_CODE',
  status: 400,
  code: 'INVALID_TWO_FACTOR_CODE',
});
const guest = () => server.use(contractResponse('refreshToken', { status: 401 }));

describe('data loading', () => {
  it('a 5xx GET is retried twice (3 requests), then the failed state with «Повторить»', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/notifications`, () => {
        calls++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    await renderApp('/notifications');
    expect(await screen.findByText('Уведомления не загрузились.', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(calls).toBe(3);
  });

  it('a 4xx GET is not retried (1 request)', async () => {
    let calls = 0;
    server.use(contractResponse('listNotifications', { status: 403, onRequest: () => void calls++ }));
    await renderApp('/notifications');
    expect(await screen.findByText('Уведомления не загрузились.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls).toBe(1);
  });

  it('a screen opened again within 30 s shows its data at once, without a request', async () => {
    let calls = 0;
    server.use(
      contractResponse('listNotifications', { body: pageOf([note(12)]), onRequest: () => void calls++ }),
    );
    const { router } = await renderApp('/notifications');
    await screen.findByRole('link', { name: 'Изъять партию AT-2026-000012' });
    await router.goto('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    await router.goto('/notifications');
    await screen.findByRole('heading', { level: 1, name: 'Уведомления' });
    expect(screen.getByRole('link', { name: 'Изъять партию AT-2026-000012' })).toBeInTheDocument();
    expect(calls).toBe(1);
  });

  it('requests of the same key in flight are shared', async () => {
    guest();
    await renderApp('/login');
    let loads = 0;
    const load = () =>
      new Promise<number>((r) => {
        loads++;
        setTimeout(() => r(7), 50);
      });
    const [a, b] = await Promise.all([cache.fetch(['k'], load), cache.fetch(['k'], load)]);
    expect([a, b, loads]).toEqual([7, 7, 1]);
    expect(cache.peek(['k'])).toBe(7);
  });

  it('the cache ends with the session (logout)', async () => {
    let calls = 0;
    server.use(
      contractResponse('listNotifications', { body: pageOf([note(12)]), onRequest: () => void calls++ }),
    );
    const { session } = await renderApp('/notifications');
    await screen.findByRole('link', { name: 'Изъять партию AT-2026-000012' });
    expect(cache.peek(['notifications', 'all', 1])).toBeDefined();
    await session.signOut();
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(cache.peek(['notifications', 'all', 1])).toBeUndefined();
  });

  it('a failed tab change drops the rows of the other tab: failed state, «Повторить», bulk actions disabled', async () => {
    server.use(contractResponse('listNotifications', { body: pageOf([note(12), note(11)]) }));
    await renderApp('/notifications');
    await screen.findByRole('link', { name: 'Изъять партию AT-2026-000012' });
    server.use(contractResponse('listNotifications', { status: 403 }));
    await userEvent.click(screen.getByRole('tab', { name: /Непрочитанные/ }));
    expect(await screen.findByText('Уведомления не загрузились.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Изъять партию AT-2026-000012' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отметить все прочитанными' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('a failed refetch of the same key keeps the rows and says so in a toast', async () => {
    server.use(contractResponse('listNotifications', { body: pageOf([note(12)]) }));
    await renderApp('/notifications');
    await screen.findByRole('link', { name: 'Изъять партию AT-2026-000012' });
    server.use(contractResponse('listNotifications', { status: 400 }));
    await cache.invalidate(['notifications']);
    expect(screen.getByRole('link', { name: 'Изъять партию AT-2026-000012' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('.at-toast-region[role="alert"] .at-toast__text')).toHaveTextContent(
        'Уведомления не загрузились.',
      ),
    );
  });
});

describe('focus after an action removed the focused control', () => {
  it('«Отметить прочитанным» goes away with the selection: the focus is on the page title', async () => {
    server.use(
      contractResponse('listNotifications', { body: pageOf([note(12), note(11)]) }),
      contractResponse('markNotificationsRead', { body: { count: 1 } }),
    );
    await renderApp('/notifications');
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Выбрать «Изъять партию AT-2026-000011»' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Отметить прочитанным' }));
    await waitFor(() => expect(h1('Уведомления')).toHaveFocus());
  });

  it('2FA: «Настроить» → the code field; «Отмена» → «Настроить»; reopened clean', async () => {
    server.use(
      asMe({ roles: ['ADMIN'] }),
      contractResponse('setupTwoFactor', { example: 'pending', once: true }),
      contractResponse('setupTwoFactor', { status: 400, body: problem400Code(), once: true }),
      contractResponse('setupTwoFactor', { example: 'pending' }),
    );
    await renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const card = () =>
      within(
        screen.getByRole('heading', { level: 2, name: 'Двухфакторная аутентификация' }).closest('article')!,
      );
    await userEvent.click(card().getByRole('button', { name: 'Настроить' }));
    await waitFor(() => expect(card().getByLabelText('Код из приложения')).toHaveFocus());
    await userEvent.type(card().getByLabelText('Код из приложения'), '000000');
    await userEvent.click(card().getByRole('button', { name: 'Включить' }));
    await waitFor(() =>
      expect(card().getByLabelText('Код из приложения')).toHaveAttribute('aria-invalid', 'true'),
    );
    await userEvent.click(card().getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(card().getByRole('button', { name: 'Настроить' })).toHaveFocus());
    await userEvent.click(card().getByRole('button', { name: 'Настроить' }));
    const field = await card().findByLabelText('Код из приложения');
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(field).toHaveValue('');
  });

  it('2FA start 429: the focus is not moved during the wait; «Настроить» takes it back', async () => {
    server.use(
      asMe({ roles: ['ADMIN'] }),
      contractResponse('setupTwoFactor', { status: 429, headers: { 'Retry-After': '1' } }),
    );
    await renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const card = within(
      screen.getByRole('heading', { level: 2, name: 'Двухфакторная аутентификация' }).closest('article')!,
    );
    await userEvent.click(card.getByRole('button', { name: 'Настроить' }));
    await card.findByRole('button', { name: 'Повторить через 1 с' });
    await new Promise((r) => setTimeout(r, 300));
    expect(h1('Профиль')).not.toHaveFocus();
    const setup = await card.findByRole('button', { name: 'Настроить' }, { timeout: 2500 });
    await waitFor(() => expect(setup).toHaveFocus());
  });
});

describe('form behaviour (React Hook Form reference)', () => {
  it('client errors appear only after the first submit', async () => {
    guest();
    await renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.tab();
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Некорректный email');
  });

  it('a client-side refusal focuses the first invalid field; errors follow the typing afterwards', async () => {
    guest();
    await renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Пароль'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveFocus());
    expect(screen.getByLabelText('Пароль')).not.toHaveAttribute('aria-invalid');
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.ru');
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    await userEvent.clear(screen.getByLabelText('Пароль'));
    expect(screen.getByLabelText('Пароль')).toHaveAccessibleDescription('Обязательное поле');
  });

  it('a server field error stays until that field changes', async () => {
    guest();
    server.use(
      contractResponse('login', {
        status: 400,
        body: {
          type: '/problems/validation',
          title: 'VALIDATION',
          status: 400,
          code: 'VALIDATION',
          errors: { email: ['validation.email.taken'] },
        },
      }),
    );
    await renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    const email = screen.getByLabelText('Email');
    await waitFor(() => expect(email).toHaveAccessibleDescription('Email уже зарегистрирован'));
    await userEvent.type(screen.getByLabelText('Пароль'), 'y');
    expect(email).toHaveAccessibleDescription('Email уже зарегистрирован');
    await userEvent.type(email, 'u');
    expect(email).not.toHaveAttribute('aria-invalid');
  });

  it('when the 429 wait ends the submit takes the focus back', async () => {
    guest();
    server.use(contractResponse('login', { status: 429, headers: { 'Retry-After': '1' } }));
    await renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'petrov@kfh-petrov.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'agrotrace-demo');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('button', { name: 'Повторить через 1 с' });
    const login = await screen.findByRole('button', { name: 'Войти' }, { timeout: 2500 });
    await waitFor(() => expect(login).toHaveFocus());
  });

  it('a field the person moved to during the wait keeps the focus when the wait ends', async () => {
    guest();
    server.use(contractResponse('login', { status: 429, headers: { 'Retry-After': '1' } }));
    await renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'petrov@kfh-petrov.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'agrotrace-demo');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('button', { name: 'Повторить через 1 с' });
    screen.getByLabelText('Email').focus();
    const login = await screen.findByRole('button', { name: 'Войти' }, { timeout: 2500 });
    await new Promise((r) => setTimeout(r, 100));
    expect(login).not.toHaveFocus();
    expect(screen.getByLabelText('Email')).toHaveFocus();
  });

  it('a card form (profile «Сохранить») gets the focus back after its 429 wait', async () => {
    server.use(contractResponse('updateMe', { status: 429, headers: { 'Retry-After': '1' } }));
    await renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const personal = within(
      screen.getByRole('heading', { level: 2, name: 'Личные данные' }).closest('article')!,
    );
    await userEvent.type(personal.getByLabelText('ФИО'), 'а');
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    await personal.findByRole('button', { name: 'Повторить через 1 с' });
    const save = await personal.findByRole('button', { name: 'Сохранить' }, { timeout: 2500 });
    await waitFor(() => expect(save).toHaveFocus());
  });

  it('the telegram link code valid longer than a timer can wait (2^31 ms) stays on screen', async () => {
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: false, telegramLinked: false } }),
      contractResponse('createTelegramCode', {
        body: { code: 'K7M2Q9XA', expiresAt: '2099-01-01T10:00:00Z', botUsername: 'agrotrace_bot' },
      }),
    );
    await renderApp('/profile');
    const channels = within(
      (await screen.findByRole('heading', { level: 2, name: 'Каналы уведомлений' })).closest('article')!,
    );
    await userEvent.click(await channels.findByRole('button', { name: 'Привязать Telegram' }));
    await channels.findByText('Отправьте боту @agrotrace_bot команду /start K7M2Q9XA');
    await new Promise((r) => setTimeout(r, 300));
    expect(channels.getByRole('link', { name: 'Открыть Telegram' })).toBeInTheDocument();
  });
});
