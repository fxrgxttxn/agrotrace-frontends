import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { FakeEventSource, renderApp } from '../app/renderApp';

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
const pageOf = (items: unknown[]) => ({ items, page: 1, size: 20, total: items.length });
const link = (seq: number) => ({ name: `Изъять партию AT-2026-${String(seq).padStart(6, '0')}` });
const alertText = () =>
  [...document.querySelectorAll('.at-toast-region[role="alert"] .at-toast__text')]
    .map((n) => n.textContent)
    .join('|');

afterEach(() => vi.restoreAllMocks());

describe('data loading', () => {
  it('a retry re-requests the tab it started with, even after the user switched tabs meanwhile', async () => {
    const seen: string[] = [];
    let unreadCalls = 0;
    server.use(
      http.get(`${API_BASE}/notifications`, ({ request }) => {
        const unread = new URL(request.url).searchParams.get('isRead') === 'false';
        seen.push(unread ? 'unread' : 'all');
        if (!unread) return HttpResponse.json(pageOf([note(12), note(11)]));
        unreadCalls++;
        if (unreadCalls === 1) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json(pageOf([note(5)]));
      }),
    );
    renderApp('/notifications');
    await screen.findByRole('link', link(12));
    await userEvent.click(screen.getByRole('tab', { name: /Непрочитанные/ }));
    await waitFor(() => expect(unreadCalls).toBe(1));
    await userEvent.click(screen.getByRole('tab', { name: /Все/ }));
    await waitFor(() => expect(unreadCalls).toBe(2), { timeout: 3000 });
    await userEvent.click(screen.getByRole('tab', { name: /Непрочитанные/ }));
    expect(await screen.findByRole('link', link(5))).toBeInTheDocument();
    expect(screen.queryByRole('link', link(12))).not.toBeInTheDocument();
    expect(seen).toEqual(['all', 'unread', 'unread']);
  });

  it('a live notification while the user is elsewhere makes the list stale: back on it, it is asked for again', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/notifications`, () => {
        calls++;
        return HttpResponse.json(pageOf(calls === 1 ? [note(12)] : [note(13), note(12)]));
      }),
    );
    const { router, fixture } = renderApp('/notifications');
    await screen.findByRole('link', link(12));
    await fixture.ngZone!.run(() => router.navigateByUrl('/profile'));
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    FakeEventSource.last!.emit('notification', note(13), '13');
    await fixture.ngZone!.run(() => router.navigateByUrl('/notifications'));
    expect(await screen.findByRole('link', link(13))).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('after 30 s the stale rows are shown busy while asked for again, then replaced', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/notifications`, async () => {
        calls++;
        if (calls > 1) await delay(400);
        return HttpResponse.json(pageOf(calls === 1 ? [note(12)] : [note(13), note(12)]));
      }),
    );
    const { router, fixture } = renderApp('/notifications');
    await screen.findByRole('link', link(12));
    await fixture.ngZone!.run(() => router.navigateByUrl('/profile'));
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    await fixture.ngZone!.run(() => router.navigateByUrl('/notifications'));
    await screen.findByRole('heading', { level: 1, name: 'Уведомления' });
    expect(screen.getByRole('link', link(12))).toBeInTheDocument();
    expect(document.querySelector('.at-table-wrap')!.parentElement).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByRole('link', link(13))).toBeInTheDocument();
    expect(document.querySelector('.at-table-wrap')!.parentElement).not.toHaveAttribute('aria-busy');
  });

  it('a failed refetch of stale rows keeps them and says so (failed toast), no failed state', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/notifications`, () => {
        calls++;
        return calls === 1
          ? HttpResponse.json(pageOf([note(12)]))
          : HttpResponse.json(
              { type: '/problems/forbidden', title: 'Forbidden', status: 403, code: 'FORBIDDEN' },
              { status: 403 },
            );
      }),
    );
    const { router, fixture } = renderApp('/notifications');
    await screen.findByRole('link', link(12));
    await fixture.ngZone!.run(() => router.navigateByUrl('/profile'));
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    await fixture.ngZone!.run(() => router.navigateByUrl('/notifications'));
    await waitFor(() => expect(alertText()).toBe('Уведомления не загрузились.'));
    expect(screen.getByRole('link', link(12))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('a late result of an ended session never reaches the next user (channels PUT answering after logout)', async () => {
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: false, telegramLinked: true } }),
      http.put(`${API_BASE}/me/channels`, async () => {
        await delay(600);
        return HttpResponse.json({ email: false, telegram: false, telegramLinked: true });
      }),
    );
    renderApp('/profile');
    const channels = () =>
      within(screen.getByRole('heading', { level: 2, name: 'Каналы уведомлений' }).closest('article')!);
    await screen.findByRole('heading', { level: 2, name: 'Каналы уведомлений' });
    await userEvent.click(await channels().findByRole('switch', { name: 'Email' }));
    await userEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'b@farm.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'agrotrace-demo');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('heading', { level: 1, name: 'Панель' });
    await new Promise((r) => setTimeout(r, 800));
    await userEvent.click(screen.getByRole('link', { name: /^Профиль, / }));
    await screen.findByRole('heading', { level: 2, name: 'Каналы уведомлений' });
    expect(await channels().findByRole('switch', { name: 'Email' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('focus', () => {
  it('«Настроить» reveals the 2FA form: its code field gets the focus', async () => {
    server.use(asMe({ roles: ['ADMIN'] }), contractResponse('setupTwoFactor', { example: 'pending' }));
    renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    await userEvent.click(screen.getByRole('button', { name: 'Настроить' }));
    const code = await screen.findByLabelText('Код из приложения');
    await waitFor(() => expect(code).toHaveFocus());
  });
});
