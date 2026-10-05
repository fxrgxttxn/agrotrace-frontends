import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { safeNext } from '../../src/app/session';
import { renderApp } from './renderApp';

const me = () => contractExample('getMe').body as Record<string, unknown>;
const asMe = (patch: Record<string, unknown>) => contractResponse('getMe', { body: { ...me(), ...patch } });
const query = (url: string) => new URLSearchParams(url.split('?')[1] ?? '');
const pathOf = (url: string) => url.split('?')[0];

describe('session start-up', () => {
  it('restores the session from the refresh cookie and loads /me into the shell', async () => {
    let refreshCalls = 0;
    server.use(contractResponse('refreshToken', { onRequest: () => void refreshCalls++ }));
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Панель' })).toBeInTheDocument();
    expect(screen.getByText('КФХ Петров')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Профиль, Петров Иван Сергеевич' })).toBeInTheDocument();
    expect(refreshCalls).toBe(1);
  });

  it('sends the access token from the refresh as Bearer to /me (through HttpClient)', async () => {
    let auth: string | null = null;
    server.use(contractResponse('getMe', { onRequest: (r) => void (auth = r.headers.get('Authorization')) }));
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Панель' });
    const token = (contractExample('refreshToken').body as { accessToken: string }).accessToken;
    expect(auth).toBe(`Bearer ${token}`);
  });

  it('without a session a cabinet route goes to /login?next=', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    const { url } = renderApp('/batches?status=Approved');
    expect(await screen.findByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    expect(pathOf(url())).toBe('/login');
    expect(query(url()).get('next')).toBe('/batches?status=Approved');
    expect(screen.queryByText('Сессия истекла — войдите снова')).not.toBeInTheDocument();
  });

  it('a transient failure of the refresh (R61) shows «unavailable» with a retry, not the login', async () => {
    server.use(
      http.post(`${API_BASE}/auth/refresh`, () => new HttpResponse(null, { status: 503 }), { once: true }),
    );
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Сервис недоступен' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Панель' })).toBeInTheDocument();
  });

  it('a network error of the refresh is transient too', async () => {
    server.use(http.post(`${API_BASE}/auth/refresh`, () => HttpResponse.error(), { once: true }));
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Сервис недоступен' })).toBeInTheDocument();
  });

  it('429 of the refresh (R61, F8) is not a logout: «unavailable», retry after a wait', async () => {
    server.use(
      http.post(
        `${API_BASE}/auth/refresh`,
        () =>
          HttpResponse.json(
            { type: '/problems/rate-limited', title: 'Too many requests', status: 429, code: 'RATE_LIMITED' },
            { status: 429, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '2' } },
          ),
        { once: true },
      ),
    );
    const { url } = renderApp('/fields');
    expect(await screen.findByRole('heading', { level: 1, name: 'Сервис недоступен' })).toBeInTheDocument();
    expect(screen.getByText('Слишком много запросов — попробуйте позже')).toBeInTheDocument();
    expect(url()).toBe('/fields');
    expect(screen.getByRole('button', { name: /^Повторить через \d+ с$/ })).toBeDisabled();
    await userEvent.click(await screen.findByRole('button', { name: 'Повторить' }, { timeout: 22000 }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Поля' })).toBeInTheDocument();
  }, 30000);

  it('429 of GET /me keeps the session: the retry waits Retry-After and reuses the token', async () => {
    let refreshes = 0;
    server.use(
      contractResponse('refreshToken', { onRequest: () => void refreshes++ }),
      contractResponse('getMe', { status: 429, headers: { 'Retry-After': '2' }, once: true }),
    );
    const { url, core } = renderApp('/fields');
    expect(await screen.findByRole('heading', { level: 1, name: 'Сервис недоступен' })).toBeInTheDocument();
    expect(screen.getByText('Слишком много запросов — попробуйте позже')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить через 2 с' })).toBeDisabled();
    expect(core.store.get()).not.toBeNull();
    expect(url()).toBe('/fields');
    const retry = await screen.findByRole('button', { name: 'Повторить' }, { timeout: 3500 });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    await userEvent.click(retry);
    expect(await screen.findByRole('heading', { level: 1, name: 'Поля' })).toBeInTheDocument();
    expect(refreshes).toBe(1);
  });

  it('after a successful retry the role guard runs: a deep link of another role ends on /403', async () => {
    server.use(
      http.post(`${API_BASE}/auth/refresh`, () => new HttpResponse(null, { status: 503 }), { once: true }),
    );
    const { url } = renderApp('/admin/users');
    expect(await screen.findByRole('heading', { level: 1, name: 'Сервис недоступен' })).toBeInTheDocument();
    expect(url()).toBe('/admin/users');
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Нет доступа' })).toBeInTheDocument();
    expect(url()).toBe('/403');
  });

  it('a retry that fails again (loading → unavailable) puts the focus back on «Повторить»', async () => {
    server.use(http.post(`${API_BASE}/auth/refresh`, () => new HttpResponse(null, { status: 503 })));
    renderApp('/fields');
    expect(await screen.findByRole('heading', { level: 1, name: 'Сервис недоступен' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Повторить' })),
    );
  });

  it('a cabinet deep link with a #fragment: `next` keeps path and query, never the fragment', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    const { url } = renderApp('/batches?status=Approved#top');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(url()).toBe('/login?next=%2Fbatches%3Fstatus%3DApproved');
  });

  it('after a successful retry an anonymous user goes to /login?next=', async () => {
    server.use(
      http.post(`${API_BASE}/auth/refresh`, () => new HttpResponse(null, { status: 503 }), { once: true }),
      contractResponse('refreshToken', { status: 401 }),
    );
    const { url } = renderApp('/fields');
    expect(await screen.findByRole('heading', { level: 1, name: 'Сервис недоступен' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    expect(url()).toBe('/login?next=%2Ffields');
  });
});

describe('login', () => {
  it('signs in and continues to `next`', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    const { url } = renderApp('/login?next=%2Fbatches');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'petrov@kfh-petrov.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Партии' })).toBeInTheDocument();
    expect(url()).toBe('/batches');
  });

  it('shows the problem text of a wrong password in an error toast', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }), contractResponse('login', { status: 401 }));
    renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    const alert = await screen.findByText('Неверный email или пароль');
    expect(alert.closest('[role="alert"]')).not.toBeNull();
  });

  it('marks empty fields without calling the API', async () => {
    let called = false;
    server.use(
      contractResponse('refreshToken', { status: 401 }),
      contractResponse('login', { onRequest: () => void (called = true) }),
    );
    renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Обязательное поле');
    expect(called).toBe(false);
  });

  it('TOTP users continue on /login/2fa', async () => {
    server.use(
      contractResponse('refreshToken', { status: 401 }),
      contractResponse('login', { example: 'twoFactor' }),
    );
    const { url, router } = renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Код подтверждения' })).toBeInTheDocument();
    expect(url()).toBe('/login/2fa');
    expect(router.lastSuccessfulNavigation?.extras.state).toEqual({
      challengeId: 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f',
    });
  });

  it('a signed-in user opening /login goes home', async () => {
    const { url } = renderApp('/login');
    expect(await screen.findByRole('heading', { level: 1, name: 'Панель' })).toBeInTheDocument();
    expect(url()).toBe('/');
  });
});

describe('session loss and logout', () => {
  it('an explicit logout lands on a plain /login (no `next` back into the cabinet)', async () => {
    const { url } = renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    await userEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await waitFor(() => expect(url()).toBe('/login'));
  });

  it('an access token rejected and a failed refresh send the user to /login?next= with a message', async () => {
    const { url, core, fixture } = renderApp('/fields?page=2');
    await screen.findByRole('heading', { level: 1, name: 'Поля' });
    server.use(contractResponse('refreshToken', { status: 401 }), contractResponse('getMe', { status: 401 }));
    await fixture.ngZone!.run(() => core.api.GET('/me'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    expect(pathOf(url())).toBe('/login');
    expect(query(url()).get('next')).toBe('/fields?page=2');
    expect(screen.getByText('Сессия истекла — войдите снова')).toBeInTheDocument();
    expect(core.store.get()).toBeNull();
  });

  it('logout ends the session here and tells the other tabs', async () => {
    const other = new BroadcastChannel('agrotrace-session');
    const got: unknown[] = [];
    other.onmessage = (e) => got.push(e.data);
    const { url } = renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    await userEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    expect(url()).toBe('/login');
    await waitFor(() => expect(got).toEqual([{ type: 'logout' }]));
    other.close();
  });

  it('a logout in another tab ends this session', async () => {
    const { url } = renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    const other = new BroadcastChannel('agrotrace-session');
    other.postMessage({ type: 'logout' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    expect(url()).toBe('/login');
    other.close();
  });

  it('a logout in another tab while this one is still restoring: the late /me never signs it in', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    server.use(contractResponse('getMe', { onRequest: () => held }));
    const { url } = renderApp('/batches');
    await new Promise((r) => setTimeout(r, 50));
    const other = new BroadcastChannel('agrotrace-session');
    other.postMessage({ type: 'logout' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Вход' })).toBeInTheDocument();
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByRole('heading', { level: 1, name: 'Партии' })).toBeNull();
    expect(pathOf(url())).toBe('/login');
    other.close();
  });

  it("sign-in while a restore voided by another tab's logout still waits: the late refresh never replaces the new token", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    server.use(
      contractResponse('refreshToken', {
        body: { ...(contractExample('refreshToken').body as object), accessToken: 'stale.cookie.token' },
        onRequest: () => held,
      }),
    );
    const { url, core } = renderApp('/login');
    await new Promise((r) => setTimeout(r, 50));
    const other = new BroadcastChannel('agrotrace-session');
    other.postMessage({ type: 'logout' });
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    await userEvent.type(screen.getByLabelText('Email'), 'petrov@kfh-petrov.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await waitFor(() => expect(pathOf(url())).toBe('/'));
    const signedIn = core.store.get();
    expect(signedIn).toBe((contractExample('login').body as { accessToken: string }).accessToken);
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(core.store.get()).toBe(signedIn);
    expect(pathOf(url())).toBe('/');
    other.close();
  });
});

describe('role guard', () => {
  it('a route of another role goes to /403', async () => {
    const { url } = renderApp('/admin/users');
    expect(await screen.findByRole('heading', { level: 1, name: 'Нет доступа' })).toBeInTheDocument();
    expect(url()).toBe('/403');
    expect(screen.getAllByRole('navigation', { name: 'Основное меню', hidden: true })).toHaveLength(2);
    expect(document.querySelector('.at-card .at-empty svg.at-empty__art')).not.toBeNull();
  });

  it('LAB has no batch registry', async () => {
    server.use(asMe({ roles: ['LAB'], isOrgAdmin: false }));
    const { url } = renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Нет доступа' });
    expect(url()).toBe('/403');
  });

  it('the head of an organization may open /org/staff', async () => {
    renderApp('/org/staff');
    expect(await screen.findByRole('heading', { level: 1, name: 'Сотрудники' })).toBeInTheDocument();
  });

  it('an employee may not open /org/staff', async () => {
    server.use(asMe({ isOrgAdmin: false }));
    renderApp('/org/staff');
    expect(await screen.findByRole('heading', { level: 1, name: 'Нет доступа' })).toBeInTheDocument();
  });

  it('an unknown path is the 404 page with its illustration', async () => {
    renderApp('/no/such/page');
    expect(await screen.findByRole('heading', { level: 1, name: 'Страница не найдена' })).toBeInTheDocument();
    expect(screen.getByText('Такой страницы нет.')).toBeInTheDocument();
    expect(
      within(document.querySelector('.at-empty')! as HTMLElement).getByRole('link', { name: 'На главную' }),
    ).toHaveAttribute('href', '/');
  });

  it('404 without a session stands alone and offers the login', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    renderApp('/no/such/page');
    expect(await screen.findByRole('heading', { level: 1, name: 'Страница не найдена' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Войти' })).toHaveAttribute('href', '/login');
    expect(document.querySelector('.at-shell')).toBeNull();
  });
});

describe('safeNext', () => {
  it('keeps same-origin paths only', () => {
    expect(safeNext('/batches?x=1')).toBe('/batches?x=1');
    expect(safeNext('/batches?x=1#top')).toBe('/batches?x=1');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/login?next=/x')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});
