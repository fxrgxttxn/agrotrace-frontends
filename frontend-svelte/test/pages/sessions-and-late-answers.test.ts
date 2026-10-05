import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { FakeEventSource, renderApp } from '../app/renderApp';
import { cache } from '../../src/lib/app/cache.svelte';

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
const link = (seq: number) => ({ name: `Изъять партию AT-2026-${String(seq).padStart(6, '0')}` });
const alertText = () =>
  [...document.querySelectorAll('.at-toast-region[role="alert"] .at-toast__text')]
    .map((n) => n.textContent)
    .join('|');
const card = (title: string) =>
  within(screen.getByRole('heading', { level: 2, name: title }).closest('article')!);
const released = () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  return { held, release };
};

afterEach(() => vi.useRealTimers());

describe('late answers belong to the session they were asked in', () => {
  it('a channels PUT answering after logout and another login never reaches the next person (cache or screen)', async () => {
    const put = released();
    server.use(
      contractResponse('getMyChannels', {
        body: { email: true, telegram: false, telegramLinked: true },
        once: true,
      }),
      contractResponse('updateMyChannels', {
        body: { email: false, telegram: false, telegramLinked: true },
        onRequest: () => put.held,
      }),
    );
    const { router, session } = await renderApp('/profile');
    await userEvent.click(await card('Каналы уведомлений').findByRole('switch', { name: 'Email' }));
    await session.signOut();
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: true, telegramLinked: true } }),
    );
    await userEvent.type(screen.getByLabelText('Email'), 'b@farm.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'agrotrace-demo');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('heading', { level: 1, name: 'Панель' });
    await router.goto('/profile');
    const email = await card('Каналы уведомлений').findByRole('switch', { name: 'Email' });
    expect(email).toHaveAttribute('aria-checked', 'true');
    put.release();
    await new Promise((r) => setTimeout(r, 100));
    expect(cache.peek(['me', 'channels'])).toEqual({ email: true, telegram: true, telegramLinked: true });
    await router.goto('/notifications');
    await router.goto('/profile');
    expect(await card('Каналы уведомлений').findByRole('switch', { name: 'Email' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(card('Каналы уведомлений').getByRole('switch', { name: 'Telegram' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(alertText()).toBe('');
  });

  it('a retry never runs after the session ended (no GET after logout)', async () => {
    const after: string[] = [];
    let ended = false;
    server.use(
      http.get(`${API_BASE}/notifications`, () => {
        if (ended) after.push('GET');
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const { session } = await renderApp('/notifications');
    await new Promise((r) => setTimeout(r, 200));
    ended = true;
    await session.signOut();
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await new Promise((r) => setTimeout(r, 3500));
    expect(after).toEqual([]);
  });
});

describe('a retry asks for the key it started with', () => {
  it('switching the tab back during the retry of «Непрочитанные» does not turn that retry into «Все»', async () => {
    const seen: string[] = [];
    let unreadFails = 1;
    server.use(
      http.get(`${API_BASE}/notifications`, ({ request }) => {
        const unread = new URL(request.url).searchParams.get('isRead') === 'false';
        seen.push(unread ? 'unread' : 'all');
        if (unread && unreadFails-- > 0) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json(pageOf(unread ? [note(5)] : [note(12), note(11)]));
      }),
    );
    await renderApp('/notifications');
    await screen.findByRole('link', link(12));
    await userEvent.click(screen.getByRole('tab', { name: /Непрочитанные/ }));
    await new Promise((r) => setTimeout(r, 100));
    await userEvent.click(screen.getByRole('tab', { name: 'Все' }));
    await new Promise((r) => setTimeout(r, 1500));
    expect(seen).toEqual(['all', 'unread', 'unread']);
    expect(screen.getByRole('link', link(12))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Непрочитанные/ }));
    expect(await screen.findByRole('link', link(5))).toBeInTheDocument();
    expect(screen.queryByRole('link', link(12))).not.toBeInTheDocument();
    expect(seen).toEqual(['all', 'unread', 'unread']);
  });
});

describe('stale-while-revalidate', () => {
  it('an answer older than 30 s is shown busy while asked again; if that fails, the rows stay with a toast', async () => {
    server.use(contractResponse('listNotifications', { body: pageOf([note(12)]) }));
    const { router } = await renderApp('/notifications');
    await screen.findByRole('link', link(12));
    await router.goto('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const later = Date.now() + 31_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const get = released();
    server.use(
      http.get(`${API_BASE}/notifications`, async () => {
        await get.held;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    await router.goto('/notifications');
    expect(await screen.findByRole('link', link(12))).toBeInTheDocument();
    expect(screen.getByRole('link', link(12)).closest('[aria-busy="true"]')).not.toBeNull();
    expect(document.querySelectorAll('.at-skeleton')).toHaveLength(0);
    get.release();
    await waitFor(() => expect(alertText()).toBe('Уведомления не загрузились.'), { timeout: 6000 });
    expect(screen.getByRole('link', link(12))).toBeInTheDocument();
    expect(screen.getByRole('link', link(12)).closest('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
  });
});

describe('the focus rescue follows only the person’s own input', () => {
  it('a passive refresh (SSE) that removes the focused row leaves the focus alone', async () => {
    server.use(contractResponse('listNotifications', { body: pageOf([note(12), note(11)]) }));
    await renderApp('/notifications');
    const box = await screen.findByRole('checkbox', { name: 'Выбрать «Изъять партию AT-2026-000011»' });
    box.focus();
    await new Promise((r) => setTimeout(r, 2200));
    server.use(contractResponse('listNotifications', { body: pageOf([note(13), note(12)]) }));
    FakeEventSource.last!.emit('notification', note(13), '13');
    await screen.findByRole('link', link(13));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('heading', { level: 1, name: 'Уведомления' })).not.toHaveFocus();
  });
});

describe('the 2FA challenge belongs to its history entry', () => {
  async function toTwoFactor() {
    server.use(
      contractResponse('refreshToken', { status: 401 }),
      contractResponse('login', { example: 'twoFactor' }),
    );
    const utils = await renderApp('/login?next=%2Fbatches');
    await userEvent.type(screen.getByLabelText('Email'), 'inspector@agrotrace.test');
    await userEvent.type(screen.getByLabelText('Пароль'), 'agrotrace-demo');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('heading', { level: 1, name: 'Код подтверждения' });
    return utils;
  }

  it('kept for a reload of the entry while the step lasts, dropped when the sign-in succeeds', async () => {
    await toTwoFactor();
    expect(sessionStorage.getItem('agrotrace-2fa-challenge')).toContain(
      'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f',
    );
    await userEvent.type(screen.getByLabelText('Код из приложения'), '482915');
    await userEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    expect(sessionStorage.getItem('agrotrace-2fa-challenge')).toBeNull();
  });

  it('a /login/2fa opened as another entry (typed) goes to /login', async () => {
    const { router } = await toTwoFactor();
    await router.goto('/register');
    await screen.findByRole('heading', { level: 1, name: 'Регистрация организации' });
    await router.goto('/login/2fa?next=%2Fbatches');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(location.pathname + location.search).toBe('/login?next=%2Fbatches');
  });
});

describe('session writes and follow-up re-reads', () => {
  const politeText = () =>
    [...document.querySelectorAll('.at-toast-region[aria-live] .at-toast__text')]
      .map((n) => n.textContent)
      .join('|');

  it('a PATCH /me answering after the logout never revives the session', async () => {
    const patch = released();
    server.use(contractResponse('updateMe', { onRequest: () => patch.held }));
    const { session } = await renderApp('/profile');
    const personal = card('Личные данные');
    await userEvent.type(personal.getByLabelText('ФИО'), ' мл.');
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    await session.signOut();
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    patch.release();
    await new Promise((r) => setTimeout(r, 200));
    expect(session.status).toBe('anonymous');
    expect(session.me).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    expect(politeText() + alertText()).toBe('');
  });

  it('an avatar upload that succeeded stays a success when the /me re-read fails', async () => {
    const UndiciFormData = (
      await new Response('', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).formData()
    ).constructor as typeof FormData;
    vi.stubGlobal('FormData', UndiciFormData);
    const { File: NodeFile } = await import('node:buffer');
    const png = new NodeFile([new Uint8Array(2048)], 'me.png', { type: 'image/png' }) as unknown as File;
    await renderApp('/profile');
    const avatar = card('Аватар');
    await userEvent.upload(avatar.getByLabelText('Файл'), png);
    server.use(http.get(`${API_BASE}/me`, () => new HttpResponse(null, { status: 503 })));
    await userEvent.click(avatar.getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(politeText()).toBe('Аватар обновлён'));
    await new Promise((r) => setTimeout(r, 3500));
    expect(alertText()).toBe('');
    expect(screen.getByRole('heading', { level: 1, name: 'Профиль' })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('the revealed 2FA field does not take the focus from a field the person moved to', async () => {
    const setup = released();
    server.use(
      contractResponse('getMe', {
        body: { ...(contractExample('getMe').body as Record<string, unknown>), roles: ['ADMIN'] },
      }),
      contractResponse('setupTwoFactor', { example: 'pending', onRequest: () => setup.held }),
    );
    await renderApp('/profile');
    await userEvent.click(card('Двухфакторная аутентификация').getByRole('button', { name: 'Настроить' }));
    card('Личные данные').getByLabelText('ФИО').focus();
    setup.release();
    await card('Двухфакторная аутентификация').findByLabelText('Код из приложения');
    await new Promise((r) => setTimeout(r, 50));
    expect(card('Личные данные').getByLabelText('ФИО')).toHaveFocus();
  });

  it('a password reset answering after the person left the screen says so but does not navigate', async () => {
    const reset = released();
    server.use(
      contractResponse('refreshToken', { status: 401 }),
      contractResponse('resetPassword', { onRequest: () => reset.held }),
    );
    const { router } = await renderApp('/password/reset/k3Jp9_Qw8Zr2Xy7Lm4Nb6Vc1Hd5Tf0Gs-Ae3Rt8Yu');
    await userEvent.type(screen.getByLabelText('Новый пароль'), 'new-password-2026');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' }));
    await router.goto('/register');
    await screen.findByRole('heading', { level: 1, name: 'Регистрация организации' });
    reset.release();
    await waitFor(() => expect(politeText()).toBe('Пароль изменён — войдите с новым паролем'));
    await new Promise((r) => setTimeout(r, 100));
    expect(location.pathname).toBe('/register');
  });
});

describe('the unread tab name', () => {
  it('reads «Непрочитанные 3» (a space before the count, as React)', async () => {
    server.use(contractResponse('listNotifications', { body: pageOf([note(12)]) }));
    await renderApp('/notifications');
    await screen.findByRole('link', link(12));
    FakeEventSource.last!.emit('unread', { count: 3 });
    expect(await screen.findByRole('tab', { name: 'Непрочитанные 3' })).toBeInTheDocument();
  });
});

describe('the rescue follows the action, however long its answer takes', () => {
  it('«Отметить прочитанным» answering after 2.5 s still hands the focus to the title', async () => {
    const answer = released();
    server.use(
      contractResponse('listNotifications', { body: pageOf([note(12), note(11)]) }),
      contractResponse('markNotificationsRead', { body: { count: 1 }, onRequest: () => answer.held }),
    );
    await renderApp('/notifications');
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Выбрать «Изъять партию AT-2026-000011»' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Отметить прочитанным' }));
    await new Promise((r) => setTimeout(r, 2500));
    answer.release();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Уведомления' })).toHaveFocus());
  });
});

describe('the generation follows real sessions only', () => {
  const politeText = () =>
    [...document.querySelectorAll('.at-toast-region[aria-live] .at-toast__text')]
      .map((n) => n.textContent)
      .join('|');

  it('another tab’s logout does not silence the login form of a tab without a session', async () => {
    const login = released();
    server.use(
      contractResponse('refreshToken', { status: 401 }),
      contractResponse('login', { status: 401, example: 'invalidCredentials', onRequest: () => login.held }),
    );
    await renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'petrov@kfh-petrov.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'agrotrace-demo');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    const other = new BroadcastChannel('agrotrace-session');
    other.postMessage({ type: 'logout' });
    other.close();
    await new Promise((r) => setTimeout(r, 100));
    login.release();
    await waitFor(() => expect(alertText()).toBe('Неверный email или пароль'));
    expect(location.pathname).toBe('/login');
  });

  it('a save of the same session that answers after the person left the profile still says so', async () => {
    const patch = released();
    server.use(contractResponse('updateMe', { onRequest: () => patch.held }));
    const { router } = await renderApp('/profile');
    const personal = card('Личные данные');
    await userEvent.type(personal.getByLabelText('ФИО'), ' мл.');
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    await router.goto('/notifications');
    await screen.findByRole('heading', { level: 1, name: 'Уведомления' });
    patch.release();
    await waitFor(() => expect(politeText()).toBe('Профиль сохранён'));
    expect(location.pathname).toBe('/notifications');
  });
});
