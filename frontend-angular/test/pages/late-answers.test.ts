import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { FakeEventSource, renderApp } from '../app/renderApp';
import { SESSION_CHANNEL } from '../../src/app/session';

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
const toastsText = () =>
  [...document.querySelectorAll('.at-toast__text')].map((n) => n.textContent).join('|');

function slowMark(ms: number, count: number) {
  return http.post(`${API_BASE}/notifications/read`, async () => {
    await delay(ms);
    return HttpResponse.json({ count });
  });
}

describe('actions that answer after their screen is gone', () => {
  it('«Отметить все прочитанными», then off to /profile: no error toast, no list request, the bell follows', async () => {
    let gets = 0;
    server.use(
      http.get(`${API_BASE}/notifications`, () => {
        gets++;
        return HttpResponse.json(pageOf([note(12)]));
      }),
      slowMark(2500, 7),
    );
    const { router, fixture } = renderApp('/notifications');
    await screen.findByRole('link', link(12));
    await userEvent.click(screen.getByRole('button', { name: 'Отметить все прочитанными' }));
    await fixture.ngZone!.run(() => router.navigateByUrl('/profile'));
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    await waitFor(
      () => expect(screen.getByRole('link', { name: 'Уведомления, непрочитанных: 7' })).toBeInTheDocument(),
      { timeout: 5000 },
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(toastsText()).toBe('');
    expect(gets).toBe(1);
  });

  it('a logout in another tab while the mark is on its way: no toast, no request, no bell for the next session', async () => {
    let gets = 0;
    server.use(
      http.get(`${API_BASE}/notifications`, () => {
        gets++;
        return HttpResponse.json(pageOf([note(12)]));
      }),
      slowMark(500, 7),
    );
    renderApp('/notifications');
    await screen.findByRole('link', link(12));
    await userEvent.click(screen.getByRole('button', { name: 'Отметить все прочитанными' }));
    const other = new BroadcastChannel(SESSION_CHANNEL);
    other.postMessage({ type: 'logout' });
    other.close();
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await new Promise((r) => setTimeout(r, 900));
    expect(toastsText()).toBe('');
    expect(gets).toBe(1);
  });

  it('a GET waiting for its retry makes no request once the session ended', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/me/channels`, () => {
        calls++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    await waitFor(() => expect(calls).toBe(1));
    await userEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await new Promise((r) => setTimeout(r, 3500));
    expect(calls).toBe(1);
  }, 15000);

  it('a live notification while the list request is on its way: that answer is stale, the list is asked for again', async () => {
    let gets = 0;
    server.use(
      http.get(`${API_BASE}/notifications`, async () => {
        gets++;
        if (gets === 1) {
          await delay(500);
          return HttpResponse.json(pageOf([note(12)]));
        }
        return HttpResponse.json(pageOf([note(13), note(12)]));
      }),
    );
    renderApp('/notifications');
    await screen.findByRole('heading', { level: 1, name: 'Уведомления' });
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    await waitFor(() => expect(gets).toBe(1));
    FakeEventSource.last!.emit('notification', note(13), '13');
    expect(await screen.findByRole('link', link(13))).toBeInTheDocument();
    expect(gets).toBe(2);
  });
});

describe('focus', () => {
  it('2FA «Отмена» gives the focus back to «Настроить»', async () => {
    server.use(
      contractResponse('getMe', {
        body: { ...(contractExample('getMe').body as object), roles: ['ADMIN'] },
      }),
      contractResponse('setupTwoFactor', { example: 'pending' }),
    );
    renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    await userEvent.click(screen.getByRole('button', { name: 'Настроить' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Настроить' })).toHaveFocus());
  });
});
