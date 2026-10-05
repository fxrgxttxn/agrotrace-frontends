import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { File as NodeFile } from 'node:buffer';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { renderApp } from '../app/renderApp';
import { TestBed } from '@angular/core/testing';
import { SESSION_CHANNEL, SessionService } from '../../src/app/session';

const me = () => contractExample('getMe').body as Record<string, unknown>;
const asMe = (patch: Record<string, unknown>) => contractResponse('getMe', { body: { ...me(), ...patch } });
const card = (title: string) =>
  within(screen.getByRole('heading', { level: 2, name: title }).closest('article')!);
const toasts = (region: 'alert' | 'polite') =>
  [
    ...document.querySelectorAll(
      region === 'alert'
        ? '.at-toast-region[role="alert"] .at-toast__text'
        : '.at-toast-region[aria-live] .at-toast__text',
    ),
  ]
    .map((n) => n.textContent)
    .join('|');
const logoutInAnotherTab = () => {
  const other = new BroadcastChannel(SESSION_CHANNEL);
  other.postMessage({ type: 'logout' });
  other.close();
};

const UndiciFormData = (
  await new Response('', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).formData()
).constructor as typeof FormData;

afterEach(() => vi.unstubAllGlobals());

describe('session writes', () => {
  it('a PATCH /me answering after another tab logged out never revives the session', async () => {
    server.use(
      http.patch(`${API_BASE}/me`, async () => {
        await delay(600);
        return HttpResponse.json({ ...me(), fullName: 'A LATE' });
      }),
    );
    renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const personal = card('Личные данные');
    await userEvent.clear(personal.getByLabelText('ФИО'));
    await userEvent.type(personal.getByLabelText('ФИО'), 'A LATE');
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    logoutInAnotherTab();
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.getByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    expect(document.querySelector('.at-shell')).toBeNull();
    expect(TestBed.inject(SessionService).status()).not.toBe('authenticated');
    expect(screen.queryByText(/A LATE/)).not.toBeInTheDocument();
    expect(toasts('polite')).toBe('');
  });

  it('avatar upload succeeds, the re-read of /me fails: the success is shown, no error, the re-read is retried', async () => {
    vi.stubGlobal('FormData', UndiciFormData);
    let meCalls = 0;
    server.use(
      http.get(`${API_BASE}/me`, () => {
        meCalls++;
        return meCalls === 1 ? HttpResponse.json(me()) : new HttpResponse(null, { status: 503 });
      }),
    );
    renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const avatar = card('Аватар');
    const file = new NodeFile([new Uint8Array(100)], 'me.png', { type: 'image/png' }) as unknown as File;
    await userEvent.upload(avatar.getByLabelText('Файл'), file);
    await userEvent.click(avatar.getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(toasts('polite')).toBe('Аватар обновлён'));
    await waitFor(() => expect(meCalls).toBe(4), { timeout: 5000 });
    expect(toasts('alert')).toBe('');
    expect(screen.getByRole('heading', { level: 1, name: 'Профиль' })).toBeInTheDocument();
  });

  it('2FA confirmed, the re-read fails: «Включена» and the success, no error', async () => {
    let meCalls = 0;
    server.use(
      http.get(`${API_BASE}/me`, () => {
        meCalls++;
        return meCalls === 1
          ? HttpResponse.json({ ...me(), roles: ['ADMIN'] })
          : new HttpResponse(null, { status: 503 });
      }),
      contractResponse('setupTwoFactor', { example: 'pending', once: true }),
      contractResponse('setupTwoFactor', { example: 'enabled' }),
    );
    renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const tfa = card('Двухфакторная аутентификация');
    await userEvent.click(tfa.getByRole('button', { name: 'Настроить' }));
    await userEvent.type(await tfa.findByLabelText('Код из приложения'), '482915');
    await userEvent.click(tfa.getByRole('button', { name: 'Включить' }));
    await waitFor(() => expect(toasts('polite')).toBe('Двухфакторная аутентификация включена'));
    expect(await tfa.findByText('Включена')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 3500));
    expect(toasts('alert')).toBe('');
  }, 15000);
});

describe('auth screens that are gone', () => {
  it('a password reset answering after the person left: the success is said, no navigation', async () => {
    server.use(
      contractResponse('refreshToken', { status: 401 }),
      http.post(`${API_BASE}/auth/password/reset`, async () => {
        await delay(600);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { router, fixture } = renderApp('/password/reset/k3Jp9_Qw8Zr2Xy7Lm4Nb6Vc1Hd5Tf0Gs-Ae3Rt8Yu');
    await screen.findByRole('heading', { level: 1, name: 'Новый пароль' });
    await userEvent.type(screen.getByLabelText('Новый пароль'), 'new-password-2026');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' }));
    await fixture.ngZone!.run(() => router.navigateByUrl('/register'));
    await screen.findByRole('heading', { level: 1, name: 'Регистрация организации' });
    await new Promise((r) => setTimeout(r, 900));
    expect(router.url).toBe('/register');
    expect(toasts('polite')).toBe('Пароль изменён — войдите с новым паролем');
  });
});

describe('focus and forms', () => {
  it('a reopened 2FA setup starts clean (no previous code or error)', async () => {
    server.use(
      asMe({ roles: ['ADMIN'] }),
      contractResponse('setupTwoFactor', { example: 'pending', once: true }),
      contractResponse('setupTwoFactor', {
        status: 400,
        body: { type: '/problems/x', title: 'x', status: 400, code: 'INVALID_TWO_FACTOR_CODE' },
        once: true,
      }),
      contractResponse('setupTwoFactor', { example: 'pending' }),
    );
    renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const tfa = card('Двухфакторная аутентификация');
    await userEvent.click(tfa.getByRole('button', { name: 'Настроить' }));
    await userEvent.type(await tfa.findByLabelText('Код из приложения'), '000000');
    await userEvent.click(tfa.getByRole('button', { name: 'Включить' }));
    await waitFor(() =>
      expect(tfa.getByLabelText('Код из приложения')).toHaveAttribute('aria-invalid', 'true'),
    );
    await userEvent.click(tfa.getByRole('button', { name: 'Отмена' }));
    await userEvent.click(tfa.getByRole('button', { name: 'Настроить' }));
    const code = await tfa.findByLabelText('Код из приложения');
    expect(code).toHaveValue('');
    expect(code).not.toHaveAttribute('aria-invalid');
  });

  it('a control hidden by display:none or [hidden] counts as removed', async () => {
    const { gone } = await import('../../src/app/focus');
    const box = document.createElement('div');
    box.innerHTML = '<button id="a">a</button><div hidden><button id="b">b</button></div>';
    document.body.append(box);
    expect(gone(box.querySelector('#a')!)).toBe(false);
    expect(gone(box.querySelector('#b')!)).toBe(true);
    (box.querySelector('#a') as HTMLElement).style.display = 'none';
    expect(gone(box.querySelector('#a')!)).toBe(true);
    box.remove();
  });

  it('an action not started by the person (a passive refresh) never moves the focus', async () => {
    const { actionOrigin, restoreFocus } = await import('../../src/app/focus');
    const h1 = document.createElement('div');
    h1.innerHTML = '<div class="at-page"><h1 class="at-page__title" tabindex="-1">T</h1></div>';
    document.body.append(h1);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    restoreFocus(actionOrigin());
    expect(document.activeElement).toBe(document.body);
    vi.restoreAllMocks();
    h1.remove();
  });

  it('a slow action the person triggered (answer after > 2 s) still gets the focus rescue', async () => {
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
    server.use(
      contractResponse('listNotifications', {
        body: { items: [note(12), note(11)], page: 1, size: 20, total: 2 },
      }),
      http.post(`${API_BASE}/notifications/read`, async () => {
        await delay(2600);
        return HttpResponse.json({ count: 1 });
      }),
    );
    renderApp('/notifications');
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Выбрать «Изъять партию AT-2026-000011»' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Отметить прочитанным' }));
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1, name: 'Уведомления' })).toHaveFocus(),
      { timeout: 5000 },
    );
  }, 15000);

  it('with sessionStorage blocked the reload still happens once (mark in the history entry)', async () => {
    const { reloadOnce } = await import('../../src/reload-mark');
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    const reload = vi.fn();
    expect(reloadOnce('/fields', reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOnce('/fields', reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
