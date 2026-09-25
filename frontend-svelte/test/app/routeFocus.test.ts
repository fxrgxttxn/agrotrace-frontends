import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { server } from '../setup';
import { contractResponse } from '../msw/fromContract';
import { renderApp } from './renderApp';

// Ruling F4 (design-system README «Фокус при смене маршрута»): every client-side pathname change except the first
// load moves focus to the new page's h1.at-page__title (tabindex="-1"). Same cases as the React test.

const h1 = (name: string) => screen.getByRole('heading', { level: 1, name });

describe('focus on route change', () => {
  it('the first load leaves focus alone; the title is focusable', async () => {
    await renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    expect(h1('Партии')).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(document.body);
  });

  it('a link inside the page moves focus to the new title', async () => {
    await renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    const sidebar = document.querySelector('.at-sidebar')! as HTMLElement;
    await userEvent.click(sidebar.querySelector('a[href="/fields"]')!);
    await screen.findByRole('heading', { level: 1, name: 'Поля' });
    await waitFor(() => expect(document.activeElement).toBe(h1('Поля')));
  });

  it('back and forward move focus to the title', async () => {
    const { router } = await renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    await router.goto('/waybills');
    await waitFor(() => expect(document.activeElement).toBe(h1('Накладные')));
    (document.activeElement as HTMLElement).blur();
    await router.back();
    await waitFor(() => expect(document.activeElement).toBe(h1('Партии')));
    await router.forward();
    await waitFor(() => expect(document.activeElement).toBe(h1('Накладные')));
  });

  it('a parameter change on the same route moves focus too', async () => {
    const { router } = await renderApp('/batches/1');
    await screen.findByRole('heading', { level: 1, name: 'Партия' });
    await router.goto('/batches/2');
    await waitFor(() => expect(document.activeElement).toBe(h1('Партия')));
  });

  it('after login the target page title has the focus', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    await renderApp('/login?next=%2Ffields');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(document.activeElement).not.toBe(h1('Вход')); // first load
    await userEvent.type(screen.getByLabelText('Email'), 'petrov@kfh-petrov.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('heading', { level: 1, name: 'Поля' });
    await waitFor(() => expect(document.activeElement).toBe(h1('Поля')));
  });

  it('a redirect at start-up counts as the first load', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    await renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(document.activeElement).toBe(document.body);
  });

  it('a query-only change does not move focus', async () => {
    const { router } = await renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    const link = document.querySelector('.at-sidebar a[href="/batches"]') as HTMLElement;
    link.focus();
    await router.goto('/batches?page=2');
    expect(document.activeElement).toBe(link);
  });

  it('a pick in «Ещё» keeps focus on «Ещё» (README), the next navigation moves it again', async () => {
    const { router } = await renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    const more = screen.getByRole('button', { name: 'Ещё', hidden: true });
    await userEvent.click(more);
    await userEvent.click(screen.getByRole('link', { name: 'Профиль', hidden: true }));
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    expect(document.activeElement).toBe(more);
    await router.goto('/fields');
    await waitFor(() => expect(document.activeElement).toBe(h1('Поля')));
  });
});
