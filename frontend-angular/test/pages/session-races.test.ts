import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { renderApp } from '../app/renderApp';
import { SESSION_CHANNEL } from '../../src/app/session';

const me = () => contractExample('getMe').body as Record<string, unknown>;
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

describe('session races and late answers', () => {
  it('a logout in another tab while this anonymous tab signs in: the login form still answers', async () => {
    server.use(
      contractResponse('refreshToken', { status: 401 }),
      http.post(`${API_BASE}/auth/login`, async () => {
        await delay(500);
        return HttpResponse.json(
          {
            type: '/problems/invalid-credentials',
            title: 'Invalid credentials',
            status: 401,
            code: 'INVALID_CREDENTIALS',
          },
          { status: 401 },
        );
      }),
    );
    const { url } = renderApp('/login?next=%2Ffields');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'petrov@kfh-petrov.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    const other = new BroadcastChannel(SESSION_CHANNEL);
    other.postMessage({ type: 'logout' });
    other.close();
    await waitFor(() => expect(toasts('alert')).toBe('Неверный email или пароль'));
    expect(url()).toBe('/login?next=%2Ffields');
    expect(screen.getByLabelText('Email')).toHaveValue('petrov@kfh-petrov.ru');
  });

  it('a 401 the auth flow handles (the session is gone) is not toasted by the form — only the session message', async () => {
    let refreshes = 0;
    server.use(
      contractResponse('getMyChannels', { body: { email: true, telegram: false, telegramLinked: true } }),
      http.post(`${API_BASE}/auth/refresh`, () => {
        refreshes++;
        return refreshes === 1
          ? HttpResponse.json(contractExample('refreshToken').body as Record<string, unknown>)
          : HttpResponse.json(
              { type: '/problems/token-expired', title: 'Expired', status: 401, code: 'TOKEN_EXPIRED' },
              { status: 401 },
            );
      }),
      http.put(`${API_BASE}/me/channels`, () =>
        HttpResponse.json(
          { type: '/problems/unauthorized', title: 'Unauthorized', status: 401, code: 'UNAUTHORIZED' },
          { status: 401 },
        ),
      ),
    );
    renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    await userEvent.click(await screen.findByRole('switch', { name: 'Email' }));
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await new Promise((r) => setTimeout(r, 300));
    expect(toasts('alert')).toBe('');
    expect(toasts('polite')).toBe('Сессия истекла — войдите снова');
  });

  it('a late success of the same session is said after its screen is gone («Профиль сохранён» on another page)', async () => {
    server.use(
      http.patch(`${API_BASE}/me`, async () => {
        await delay(1500);
        return HttpResponse.json({ ...me(), fullName: 'Петров Иван' });
      }),
    );
    const { router, fixture } = renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const personal = within(
      screen.getByRole('heading', { level: 2, name: 'Личные данные' }).closest('article')!,
    );
    await userEvent.clear(personal.getByLabelText('ФИО'));
    await userEvent.type(personal.getByLabelText('ФИО'), 'Петров Иван');
    await userEvent.click(personal.getByRole('button', { name: 'Сохранить' }));
    await fixture.ngZone!.run(() => router.navigateByUrl('/notifications'));
    await screen.findByRole('heading', { level: 1, name: 'Уведомления' });
    await waitFor(() => expect(toasts('polite')).toBe('Профиль сохранён'), { timeout: 4000 });
  });

  it('quiet failures: a cancellation and an auth-flow 401 are never told; a login 401 is', async () => {
    const { quietFailure } = await import('../../src/app/forms');
    const { ApiProblem } = await import('@agrotrace/api-client');
    const p = (status: number, code: string) =>
      new ApiProblem({ type: '/problems/x', title: code, status, code } as never, status);
    expect(quietFailure(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(quietFailure(Object.assign(new Error('x'), { name: 'CancelledError' }))).toBe(true);
    expect(quietFailure(p(401, 'UNAUTHORIZED'))).toBe(true);
    expect(quietFailure(p(401, 'INVALID_CREDENTIALS'))).toBe(false);
    expect(quietFailure(p(503, 'INTERNAL'))).toBe(false);
  });

  it('a focused control that got hidden counts as removed: the rescue focuses the page title', async () => {
    const { actionOrigin, restoreFocus } = await import('../../src/app/focus');
    const page = document.createElement('div');
    page.innerHTML =
      '<div class="at-page"><h1 class="at-page__title" tabindex="-1">T</h1><div id="box"><button id="b">b</button></div></div>';
    document.body.append(page);
    const button = page.querySelector<HTMLButtonElement>('#b')!;
    button.focus();
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const origin = actionOrigin();
    page.querySelector('#box')!.setAttribute('hidden', '');
    restoreFocus(origin);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(page.querySelector('h1'));
    page.remove();
  });
});
