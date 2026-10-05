import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { TestBed } from '@angular/core/testing';
import { server } from '../setup';
import { http, HttpResponse } from 'msw';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { renderApp } from '../app/renderApp';
import { QueryCache } from '../../src/app/query';

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

describe('data loading', () => {
  it('a 5xx GET is retried twice (3 requests), then the failed state with «Повторить»', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/notifications`, () => {
        calls++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    renderApp('/notifications');
    expect(await screen.findByText('Уведомления не загрузились.', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(calls).toBe(3);
  });

  it('a 4xx GET is not retried (1 request)', async () => {
    let calls = 0;
    server.use(contractResponse('listNotifications', { status: 403, onRequest: () => void calls++ }));
    renderApp('/notifications');
    expect(await screen.findByText('Уведомления не загрузились.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls).toBe(1);
  });

  it('a screen opened again within 30 s shows its data at once, without a request', async () => {
    let calls = 0;
    server.use(
      contractResponse('listNotifications', { body: pageOf([note(12)]), onRequest: () => void calls++ }),
    );
    const { router, fixture } = renderApp('/notifications');
    await screen.findByRole('link', { name: 'Изъять партию AT-2026-000012' });
    await fixture.ngZone!.run(() => router.navigateByUrl('/profile'));
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    await fixture.ngZone!.run(() => router.navigateByUrl('/notifications'));
    await screen.findByRole('heading', { level: 1, name: 'Уведомления' });
    await fixture.whenStable();
    expect(screen.getByRole('link', { name: 'Изъять партию AT-2026-000012' })).toBeInTheDocument();
    expect(calls).toBe(1);
  });

  it('requests of the same key in flight are shared', async () => {
    renderApp('/login');
    const cache = TestBed.inject(QueryCache);
    let loads = 0;
    const load = () =>
      new Promise<number>((r) => {
        loads++;
        setTimeout(() => r(7), 50);
      });
    const [a, b] = await Promise.all([cache.fetch('k', load), cache.fetch('k', load)]);
    expect([a, b, loads]).toEqual([7, 7, 1]);
    expect(cache.peek('k', 30_000)).toBe(7);
  });

  it('a failed tab change drops the rows of the other tab: failed state, «Повторить», bulk actions disabled', async () => {
    server.use(
      contractResponse('listNotifications', {
        body: pageOf([note(12), note(11)]),
      }),
    );
    await (async () => {
      renderApp('/notifications');
      await screen.findByRole('link', { name: 'Изъять партию AT-2026-000012' });
    })();
    server.use(contractResponse('listNotifications', { status: 403 }));
    await userEvent.click(screen.getByRole('tab', { name: /Непрочитанные/ }));
    expect(await screen.findByText('Уведомления не загрузились.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Изъять партию AT-2026-000012' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отметить все прочитанными' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });
});

describe('focus after an action removed the focused control', () => {
  it('«Отметить прочитанным» goes away with the selection: the focus is on the page title', async () => {
    server.use(
      contractResponse('listNotifications', { body: pageOf([note(12), note(11)]) }),
      contractResponse('markNotificationsRead', { body: { count: 1 } }),
    );
    renderApp('/notifications');
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Выбрать «Изъять партию AT-2026-000011»' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Отметить прочитанным' }));
    await waitFor(() => expect(h1('Уведомления')).toHaveFocus());
  });

  it('2FA: «Отмена» removes the form — the focus returns to «Настроить» that revealed it', async () => {
    server.use(asMe({ roles: ['ADMIN'] }), contractResponse('setupTwoFactor', { example: 'pending' }));
    renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const card = () =>
      within(
        screen.getByRole('heading', { level: 2, name: 'Двухфакторная аутентификация' }).closest('article')!,
      );
    await userEvent.click(card().getByRole('button', { name: 'Настроить' }));
    await userEvent.click(await card().findByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(card().getByRole('button', { name: 'Настроить' })).toHaveFocus());
  });
});

describe('form error timing (review minors)', () => {
  it('client errors appear only after the first submit', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.tab();
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Некорректный email');
  });

  it('a server field error stays until that field changes', async () => {
    server.use(
      contractResponse('refreshToken', { status: 401 }),
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
    renderApp('/login');
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

  it('a card form (profile «Сохранить») gets the focus back after its 429 wait', async () => {
    server.use(contractResponse('updateMe', { status: 429, headers: { 'Retry-After': '1' } }));
    renderApp('/profile');
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
});
