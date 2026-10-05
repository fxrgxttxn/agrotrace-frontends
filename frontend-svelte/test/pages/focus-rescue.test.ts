import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { FakeEventSource, renderApp } from '../app/renderApp';

const hex = (n: number) => n.toString(16).padStart(12, '0');
const note = (seq: number) => ({
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
  isRead: false,
  createdAt: '2026-09-24T09:00:12Z',
});
const pageOf = (items: unknown[]) => ({ items, page: 1, size: 20, total: items.length });
const link = (seq: number) => ({ name: `Изъять партию AT-2026-${String(seq).padStart(6, '0')}` });
const box = (seq: number) => ({ name: `Выбрать «Изъять партию AT-2026-${String(seq).padStart(6, '0')}»` });
const alertText = () =>
  [...document.querySelectorAll('.at-toast-region[role="alert"] .at-toast__text')]
    .map((n) => n.textContent)
    .join('|');
const politeText = () =>
  [...document.querySelectorAll('.at-toast-region[aria-live] .at-toast__text')]
    .map((n) => n.textContent)
    .join('|');
const card = (title: string) =>
  within(screen.getByRole('heading', { level: 2, name: title }).closest('article')!);
const h1 = (name: string) => screen.getByRole('heading', { level: 1, name });
const released = () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  return { held, release };
};
const me = () => contractExample('getMe').body as Record<string, unknown>;
const broadcastLogout = () => {
  const other = new BroadcastChannel('agrotrace-session');
  other.postMessage({ type: 'logout' });
  other.close();
};

afterEach(() => vi.restoreAllMocks());

describe('the focus rescue belongs to the acting screen and to own answers only', () => {
  it('a save answering after the person left for another screen does not let a live refresh take the focus', async () => {
    const patch = released();
    server.use(
      contractResponse('updateMe', { onRequest: () => patch.held }),
      contractResponse('listNotifications', { body: pageOf([note(12), note(11)]) }),
    );
    const { router } = await renderApp('/profile');
    const personal = card('Личные данные');
    await userEvent.type(personal.getByLabelText('ФИО'), ' мл.');
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    await router.goto('/notifications');
    const target = await screen.findByRole('checkbox', box(11));
    target.focus();
    await new Promise((r) => setTimeout(r, 1100));
    server.use(contractResponse('listNotifications', { body: pageOf([note(13), note(12)]) }));
    patch.release();
    FakeEventSource.last!.emit('notification', note(13), '13');
    await screen.findByRole('link', link(13));
    await new Promise((r) => setTimeout(r, 50));
    expect(h1('Уведомления')).not.toHaveFocus();
  });

  it('a live refresh right after a press is not the person’s action (SSE fetches are passive)', async () => {
    server.use(contractResponse('listNotifications', { body: pageOf([note(12), note(11)]) }));
    await renderApp('/notifications');
    await userEvent.click(await screen.findByRole('checkbox', box(11)));
    server.use(contractResponse('listNotifications', { body: pageOf([note(13), note(12)]) }));
    FakeEventSource.last!.emit('notification', note(13), '13');
    await screen.findByRole('link', link(13));
    await new Promise((r) => setTimeout(r, 50));
    expect(h1('Уведомления')).not.toHaveFocus();
  });

  it('the answer of a screen that is gone opens no rescue window on the screen now shown', async () => {
    const patch = released();
    const unread = released();
    server.use(
      contractResponse('updateMe', { onRequest: () => patch.held }),
      http.get(`${API_BASE}/notifications`, async ({ request }) => {
        if (new URL(request.url).searchParams.get('isRead') === 'false') {
          await unread.held;
          return HttpResponse.json(pageOf([note(5)]));
        }
        return HttpResponse.json(pageOf([note(12), note(11)]));
      }),
    );
    const { router } = await renderApp('/profile');
    const personal = card('Личные данные');
    await userEvent.type(personal.getByLabelText('ФИО'), ' мл.');
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    await router.goto('/notifications');
    await screen.findByRole('link', link(12));
    await router.goto('/notifications?tab=unread');
    screen.getByRole('checkbox', box(11)).focus();
    await new Promise((r) => setTimeout(r, 1100));
    patch.release();
    await new Promise((r) => setTimeout(r, 20));
    unread.release();
    await screen.findByRole('link', link(5));
    await new Promise((r) => setTimeout(r, 50));
    expect(h1('Уведомления')).not.toHaveFocus();
  });
});

describe('known results are shown at once (MR3)', () => {
  it('2FA confirmed while the profile re-read fails: «Включена» and the success, no error', async () => {
    server.use(
      contractResponse('getMe', { body: { ...me(), roles: ['ADMIN'] } }),
      contractResponse('setupTwoFactor', { example: 'pending', once: true }),
      contractResponse('setupTwoFactor', {
        example: 'enabled',
        onRequest: () =>
          void server.use(http.get(`${API_BASE}/me`, () => new HttpResponse(null, { status: 503 }))),
      }),
    );
    await renderApp('/profile');
    const tfa = card('Двухфакторная аутентификация');
    await userEvent.click(tfa.getByRole('button', { name: 'Настроить' }));
    await userEvent.type(await tfa.findByLabelText('Код из приложения'), '482915');
    await userEvent.click(tfa.getByRole('button', { name: 'Включить' }));
    expect(await tfa.findByText('Включена')).toBeInTheDocument();
    await waitFor(() => expect(politeText()).toBe('Двухфакторная аутентификация включена'));
    await new Promise((r) => setTimeout(r, 3500));
    expect(tfa.getByText('Включена')).toBeInTheDocument();
    expect(alertText()).toBe('');
  });
});

describe('another tab’s logout (MR5, MR9)', () => {
  it('a restore («Повторить») overtaken by another tab’s logout ends at the login, never in the cabinet', async () => {
    const meAnswer = released();
    server.use(
      http.post(`${API_BASE}/auth/refresh`, () => new HttpResponse(null, { status: 503 }), { once: true }),
    );
    await renderApp('/fields');
    await screen.findByRole('heading', { level: 1, name: 'Сервис недоступен' });
    server.use(contractResponse('getMe', { onRequest: () => meAnswer.held }));
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await new Promise((r) => setTimeout(r, 100));
    broadcastLogout();
    await new Promise((r) => setTimeout(r, 50));
    meAnswer.release();
    expect(await screen.findByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Поля' })).not.toBeInTheDocument();
  });

  it('a tab without a session stays where it is: the typed email and `next` are kept', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    await renderApp('/login?next=%2Ffields');
    await userEvent.type(screen.getByLabelText('Email'), 'petrov@kfh-petrov.ru');
    broadcastLogout();
    await new Promise((r) => setTimeout(r, 100));
    expect(location.pathname + location.search).toBe('/login?next=%2Ffields');
    expect(screen.getByLabelText('Email')).toHaveValue('petrov@kfh-petrov.ru');
  });
});

describe('an answer on its way when a live event arrives is not fresh (MR13)', () => {
  it('the list answer that was in flight during the invalidation is asked again on the next visit', async () => {
    const first = released();
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/notifications`, async () => {
        calls++;
        if (calls === 1) await first.held;
        return HttpResponse.json(pageOf([note(12)]));
      }),
    );
    const { router } = await renderApp('/notifications');
    await router.goto('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    FakeEventSource.last!.emit('notification', note(13), '13');
    first.release();
    await new Promise((r) => setTimeout(r, 100));
    await router.goto('/notifications');
    await screen.findByRole('link', link(12));
    expect(calls).toBe(2);
  });
});

describe('a cancelled request says nothing (MR14)', () => {
  it('a channel switch whose request was cancelled shows no error', async () => {
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: false, telegramLinked: true } }),
    );
    const { session } = await renderApp('/profile');
    vi.spyOn(session.api, 'PUT').mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );
    await userEvent.click(await card('Каналы уведомлений').findByRole('switch', { name: 'Email' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(alertText()).toBe('');
  });
});
