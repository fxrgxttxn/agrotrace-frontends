import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { contractExample } from '../msw/fromContract';
import { canonical, canonicalHtml, readmeBlock } from '../ui/readme';
import { leakedInputAttributes } from '../ui/leaks';
import { FakeEventSource, renderApp } from './renderApp';

type G = { ngDevMode?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = (globalThis as G).ngDevMode;
  (globalThis as G).ngDevMode = false;
});
afterEach(() => {
  (globalThis as G).ngDevMode = saved;
});

const me = () => contractExample('getMe').body as Record<string, unknown>;

async function shell(path = '/batches') {
  const r = renderApp(path);
  await screen.findByRole('heading', { level: 1 });
  return r;
}

describe('shell markup = README «Каркас» (production DOM)', () => {
  it('at-sidebar item: label, icon, title, aria-current for the section', async () => {
    await shell('/batches/123');
    const link = document.querySelector('.at-sidebar a[href="/batches"]')!;
    const expected = canonicalHtml(
      readmeBlock('Боковое меню').match(/<a class="at-sidebar__link"[\s\S]*?<\/a>/)![0],
    );
    expect(canonical([link])).toBe(expected);
  });

  it('at-topbar: organization, bell with count, profile avatar', async () => {
    const r = await shell();
    r.fixture.ngZone!.run(() => FakeEventSource.last!.emit('unread', { count: 3 }));
    await waitFor(() => expect(document.querySelector('.at-bell__count')).not.toBeNull());
    const header = document.querySelector('.at-topbar')!;
    const logo = header.querySelector('.at-topbar__org img')!;
    expect(logo.getAttribute('src')).toBe(`${(me().organization as { logoUrl: string }).logoUrl}?variant=96`);
    logo.setAttribute('src', '…логотип…');
    const expected = canonicalHtml(
      readmeBlock('Шапка')
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
  });

  it('at-bottom-nav: current item and «Ещё»', async () => {
    await shell('/batches');
    const nav = document.querySelector('.at-bottom-nav')!;
    const current = nav.querySelector('a[aria-current="page"]')!;
    expect(canonical([current])).toBe(
      canonicalHtml(readmeBlock('Нижняя навигация').match(/<a[\s\S]*?<\/a>/)![0]),
    );
    const more = nav.querySelector('button')!;
    expect(canonical([more])).toBe(
      canonicalHtml(readmeBlock('Нижняя навигация').match(/<button[\s\S]*?<\/button>/)![0]),
    );
  });

  it('«Ещё» dialog = README (items reduced to the two of the example)', async () => {
    await shell('/batches');
    await userEvent.click(screen.getByRole('button', { name: 'Ещё', hidden: true }));
    const dialog = document.getElementById('more-menu')!;
    await waitFor(() => expect(document.activeElement).toBe(dialog.querySelector('#more-title')));
    const clone = dialog.cloneNode(true) as HTMLElement;
    clone.removeAttribute('open');
    for (const li of clone.querySelectorAll('li'))
      if (!/recall-tasks|profile/.test(li.innerHTML)) li.remove();
    expect(canonical([clone])).toBe(canonicalHtml(readmeBlock('Нижняя навигация', 1)));
  });

  it('page header of a routed page: h1 with tabindex="-1"', async () => {
    await shell('/batches');
    const header = document
      .querySelector('.at-shell__main > .at-page > .at-page__header')!
      .cloneNode(true) as HTMLElement;
    header.querySelector('.at-page__actions')?.remove();
    expect(canonical([header])).toBe(
      canonicalHtml(
        '<div class="at-page__header"><h1 class="at-page__title" tabindex="-1">Партии</h1></div>',
      ),
    );
  });

  it('no wrapper input leaks into the DOM as an attribute (shell, profile)', async () => {
    await shell('/profile');
    expect(leakedInputAttributes(document.body)).toEqual([]);
  });

  it('no wrapper input leaks into the DOM as an attribute (the /_ds showcase: every wrapper)', async () => {
    renderApp('/_ds');
    await screen.findByRole('heading', { level: 1, name: 'Витрина компонентов' }, { timeout: 10000 });
    expect(leakedInputAttributes(document.body)).toEqual([]);
  });
});
