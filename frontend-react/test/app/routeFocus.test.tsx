import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../setup';
import { contractResponse } from '../msw/fromContract';
import { renderApp } from './renderApp';

const h1 = (name: string) => screen.getByRole('heading', { level: 1, name });

describe('focus on route change', () => {
  it('the first load leaves focus alone; the title is focusable', async () => {
    renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    expect(h1('Партии')).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(document.body);
  });

  it('a link inside the page moves focus to the new title', async () => {
    renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    const sidebar = document.querySelector('.at-sidebar')! as HTMLElement;
    await userEvent.click(sidebar.querySelector('a[href="/fields"]')!);
    await screen.findByRole('heading', { level: 1, name: 'Поля' });
    await waitFor(() => expect(document.activeElement).toBe(h1('Поля')));
  });

  it('back and forward move focus to the title', async () => {
    const { router } = renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    await act(async () => {
      await router.navigate('/waybills');
    });
    await waitFor(() => expect(document.activeElement).toBe(h1('Накладные')));
    (document.activeElement as HTMLElement).blur();
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(document.activeElement).toBe(h1('Партии')));
    await act(async () => {
      await router.navigate(1);
    });
    await waitFor(() => expect(document.activeElement).toBe(h1('Накладные')));
  });

  it('after login the target page title has the focus', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    renderApp('/login?next=%2Ffields');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(document.activeElement).not.toBe(h1('Вход'));
    await userEvent.type(screen.getByLabelText('Email'), 'petrov@kfh-petrov.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('heading', { level: 1, name: 'Поля' });
    await waitFor(() => expect(document.activeElement).toBe(h1('Поля')));
  });

  it('a redirect back to the same pathname renders the page anew: its title is focused', async () => {
    const { router } = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Панель' });
    await act(async () => {
      await router.navigate('/login');
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    await waitFor(() => expect(document.activeElement).toBe(h1('Панель')));
    await act(async () => {
      await router.navigate('/recalls');
    });
    await waitFor(() => expect(document.activeElement).toBe(h1('Нет доступа')));
    (document.activeElement as HTMLElement).blur();
    await act(async () => {
      await router.navigate('/complaints');
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/403'));
    await waitFor(() => expect(document.activeElement).toBe(h1('Нет доступа')));
  });

  it('a link to a route of another role: the redirect to /403 focuses its title', async () => {
    const { router } = renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    const link = document.querySelector('.at-sidebar a[href="/fields"]') as HTMLElement;
    link.focus();
    await act(async () => {
      await router.navigate('/recalls');
    });
    await screen.findByRole('heading', { level: 1, name: 'Нет доступа' });
    await waitFor(() => expect(document.activeElement).toBe(h1('Нет доступа')));
  });

  it('a redirect at start-up counts as the first load', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(document.activeElement).toBe(document.body);
  });

  it('a query-only change does not move focus', async () => {
    const { router } = renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    const search = document.querySelector('.at-sidebar a[href="/batches"]') as HTMLElement;
    search.focus();
    await act(async () => {
      await router.navigate('/batches?page=2');
    });
    expect(document.activeElement).toBe(search);
  });

  it('a pick in «Ещё» keeps focus on «Ещё» (README), the next navigation moves it again', async () => {
    const { router } = renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    const more = screen.getByRole('button', { name: 'Ещё', hidden: true });
    await userEvent.click(more);
    await userEvent.click(screen.getByRole('link', { name: 'Профиль', hidden: true }));
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    expect(document.activeElement).toBe(more);
    await act(async () => {
      await router.navigate('/fields');
    });
    await waitFor(() => expect(document.activeElement).toBe(h1('Поля')));
  });
});
