import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../setup';
import { contractExample, contractResponse } from '../msw/fromContract';
import { canonical, canonicalHtml, readmeBlock, readmeMenuIcons } from '../ui/readme';
import { navFor, NOTIFICATIONS_ITEM, PROFILE_ITEM } from '../../src/app/nav';
import { ALL_ROLES } from '../../src/app/access';
import { t } from '../../src/app/i18n';
import { bellCount } from '../../src/shell/Topbar';
import { FakeEventSource, renderApp } from './renderApp';

const me = () => contractExample('getMe').body as Record<string, unknown>;

async function shell(path = '/batches') {
  const r = renderApp(path);
  await screen.findByRole('heading', { level: 1 });
  return r;
}

describe('shell markup (README «Каркас»)', () => {
  it('at-shell: skip link, sidebar, topbar, main, bottom nav — in this order', async () => {
    await shell();
    const root = document.querySelector('.at-shell')!;
    expect([...root.children].map((el) => el.className || el.tagName.toLowerCase())).toEqual([
      'at-shell__skip',
      'at-sidebar',
      'at-topbar',
      'at-shell__main',
      'at-bottom-nav',
      'at-dialog',
    ]);
    const main = root.querySelector('main')!;
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(root.querySelector('.at-shell__skip')).toHaveAttribute('href', '#main');
  });

  it('at-sidebar item markup = README (label, icon, title, aria-current for the section)', async () => {
    await shell('/batches/123');
    const link = document.querySelector('.at-sidebar a[href="/batches"]')!;
    const expected = canonicalHtml(
      readmeBlock('Боковое меню').match(/<a class="at-sidebar__link"[\s\S]*?<\/a>/)![0],
    );
    expect(canonical([link])).toBe(expected);
    expect(document.querySelectorAll('.at-sidebar [aria-current="page"]')).toHaveLength(1);
    const brand = document.querySelector('.at-sidebar__brand')!;
    expect(brand).toHaveAttribute('href', '/');
    expect(brand).toHaveAttribute('title', 'AgroTrace');
  });

  it('at-topbar = README (organization, bell with count, profile avatar)', async () => {
    const { core } = await shell();
    act(() => FakeEventSource.last!.emit('unread', { count: 3 }));
    const header = document.querySelector('.at-topbar')!;
    const logo = header.querySelector('.at-topbar__org img')!;
    expect(logo.getAttribute('src')).toBe(`${(me().organization as { logoUrl: string }).logoUrl}?variant=96`);
    logo.setAttribute('src', '…логотип…');
    const expected = canonicalHtml(
      readmeBlock('Шапка')
        .replace('КФХ Петров', 'КФХ Петров')
        .replace('aria-label="Профиль, Иван Петров"', 'aria-label="Профиль, Петров Иван Сергеевич"')
        .replace(
          /<span class="at-avatar" data-size="m" aria-hidden="true">ИП<\/span>/,
          '<span class="at-avatar" data-size="m" aria-hidden="true"><img src="AVATAR" alt=""></span>',
        ),
    );
    const avatar = header.querySelector('.at-topbar__profile img')!;
    expect(avatar.getAttribute('src')).toMatch(/[?&]variant=96(&|$)/);
    avatar.setAttribute('src', 'AVATAR');
    expect(canonical([header])).toBe(expected);
    expect(core.store.get()).not.toBeNull();
  });

  it('text avatar with initials when there is no photo', async () => {
    server.use(contractResponse('getMe', { body: { ...me(), avatarUrl: null } }));
    await shell();
    const span = document.querySelector('.at-topbar__profile .at-avatar')!;
    expect(span.textContent).toBe('ПИ');
    expect(span).toHaveAttribute('aria-hidden', 'true');
  });

  it('at-bottom-nav: two-word sections take their one-line short label (README); the sidebar keeps the full one', async () => {
    server.use(
      contractResponse('getMe', {
        body: { ...(contractExample('getMe').body as Record<string, unknown>), roles: ['RETAILER'] },
      }),
    );
    await shell('/batches');
    const links = document.querySelectorAll('.at-bottom-nav a.at-bottom-nav__link');
    expect([...links].map((a) => a.textContent)).toEqual(['Панель', 'Накладные', 'Склад', 'Задачи']);
    expect(document.querySelector('.at-sidebar')!.textContent).toContain('Задачи отзыва');
  });

  it('at-bottom-nav: four items of the role + «Ещё» = README', async () => {
    await shell('/batches');
    const nav = document.querySelector('.at-bottom-nav')!;
    const links = nav.querySelectorAll('a.at-bottom-nav__link');
    expect([...links].map((a) => a.textContent)).toEqual(['Панель', 'Поля', 'Партии', 'Накладные']);
    const current = nav.querySelector('a[aria-current="page"]')!;
    expect(canonical([current])).toBe(
      canonicalHtml(readmeBlock('Нижняя навигация').match(/<a[\s\S]*?<\/a>/)![0]),
    );
    const more = nav.querySelector('button')!;
    expect(canonical([more])).toBe(
      canonicalHtml(readmeBlock('Нижняя навигация').match(/<button[\s\S]*?<\/button>/)![0]),
    );
  });

  it('«Ещё» opens the rest of the menu, notifications and profile in the README dialog; a pick closes it', async () => {
    const { router } = await shell('/batches');
    const more = screen.getByRole('button', { name: 'Ещё', hidden: true });
    await userEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const dialog = document.getElementById('more-menu')!;
    expect(dialog).toHaveAttribute('open');
    expect(document.activeElement).toBe(dialog.querySelector('#more-title'));
    const clone = dialog.cloneNode(true) as HTMLElement;
    clone.removeAttribute('open');
    for (const a of clone.querySelectorAll('li')) if (!/recall-tasks|profile/.test(a.innerHTML)) a.remove();
    expect(canonical([clone])).toBe(canonicalHtml(readmeBlock('Нижняя навигация', 1)));
    await userEvent.click(within(dialog).getByRole('link', { name: 'Уведомления' }));
    expect(router.state.location.pathname).toBe('/notifications');
    expect(dialog).not.toHaveAttribute('open');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(more);
  });
});

describe('bell (SSE counter)', () => {
  it('counts from `unread`, hides at 0, «99+» above 99', async () => {
    await shell();
    const bell = () => document.querySelector('a.at-bell')!;
    expect(bell()).toHaveAttribute('aria-label', 'Уведомления');
    expect(bell().querySelector('.at-bell__count')).toBeNull();
    act(() => FakeEventSource.last!.emit('unread', { count: 7 }));
    expect(bell()).toHaveAttribute('aria-label', 'Уведомления, непрочитанных: 7');
    expect(bell().querySelector('.at-bell__count')?.textContent).toBe('7');
    act(() => FakeEventSource.last!.emit('unread', { count: 120 }));
    expect(bell().querySelector('.at-bell__count')?.textContent).toBe('99+');
    expect(bell()).toHaveAttribute('aria-label', 'Уведомления, непрочитанных: 99+');
    act(() => FakeEventSource.last!.emit('unread', { count: 0 }));
    expect(bell().querySelector('.at-bell__count')).toBeNull();
    expect(bellCount(100)).toBe('99+');
    expect(bellCount(99)).toBe('99');
  });

  it('opens the stream with the access token and shows a new notification as a toast', async () => {
    await shell();
    const es = FakeEventSource.last!;
    const token = (contractExample('refreshToken').body as { accessToken: string }).accessToken;
    expect(new URL(es.url).searchParams.get('access_token')).toBe(token);
    expect(new URL(es.url).pathname).toBe('/api/v1/events/stream');
    act(() =>
      es.emit(
        'notification',
        {
          id: 'b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e',
          seq: 1042,
          type: 'RECALL_TASK',
          payload: {
            recallId: '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d',
            taskId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
            batchId: '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f',
            publicCode: 'AT-2026-000123',
            dueAt: '2026-09-25T15:00:00Z',
            event: 'CREATED',
          },
          isRead: false,
          createdAt: '2026-09-24T09:00:12Z',
        },
        '1042',
      ),
    );
    const toast = document.querySelector('.at-toast-region[aria-live="polite"] .at-toast')!;
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('AT-2026-000123');
    expect(toast.textContent).not.toMatch(/\{|notification\./);
  });

  it('closes the stream on logout', async () => {
    renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    const es = FakeEventSource.last!;
    await userEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    await waitFor(() => expect(es.readyState).toBe(FakeEventSource.CLOSED));
  });
});

describe('toast regions', () => {
  it('both regions exist from the start, even on the login screen', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    const regions = document.querySelectorAll('.at-toasts > .at-toast-region');
    expect(regions).toHaveLength(2);
    expect(regions[0]).toHaveAttribute('role', 'alert');
    expect(regions[1]).toHaveAttribute('aria-live', 'polite');
  });
});

describe('theme', () => {
  it('the profile switches system / light / dark on <html>', async () => {
    renderApp('/profile');
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    expect(screen.getByRole('radio', { name: 'Системная' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Тёмная' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem('agrotrace-theme')).toBe('dark');
    await userEvent.click(screen.getByRole('radio', { name: 'Светлая' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    await userEvent.click(screen.getByRole('radio', { name: 'Системная' }));
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(localStorage.getItem('agrotrace-theme')).toBeNull();
  });
});

describe('/_ds showcase (dev build only)', () => {
  it('renders every wrapper group', async () => {
    renderApp('/_ds');
    expect(await screen.findByRole('heading', { level: 1, name: 'Витрина компонентов' })).toBeInTheDocument();
    for (const name of ['at-button', 'at-chip', 'at-file', 'Иллюстрации, at-empty'])
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    expect(document.querySelectorAll('svg.at-empty__art').length).toBeGreaterThanOrEqual(12);
    expect(document.querySelectorAll('.at-chip[data-status]').length).toBeGreaterThanOrEqual(11);
  });
});

describe('menu icons (README table, F6)', () => {
  it('every menu item of every role uses the icon the README table gives its section', () => {
    const table = readmeMenuIcons();
    const items = [
      ...ALL_ROLES.flatMap((r) => [
        ...navFor({ roles: [r], isOrgAdmin: false }),
        ...navFor({ roles: [r], isOrgAdmin: true }),
      ]),
      NOTIFICATIONS_ITEM,
      PROFILE_ITEM,
    ];
    const wrong = items
      .map((i) => [t(i.label), i.icon] as const)
      .filter(([label, icon]) => table.get(label) !== icon)
      .map(([label, icon]) => `${label}: app ${icon}, README ${table.get(label) ?? '—'}`);
    expect(wrong).toEqual([]);
    expect(table.get('Задачи отзыва')).toBe('check');
    expect(table.get('Пользователи')).toBe('shield');
    expect(table.get('Журнал аудита')).toBe('eye');
  });
});
