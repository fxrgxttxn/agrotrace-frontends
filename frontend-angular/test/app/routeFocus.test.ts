import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { RoutesRecognized } from '@angular/router';
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
    const { router, fixture } = renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    await fixture.ngZone!.run(() => router.navigateByUrl('/waybills'));
    await waitFor(() => expect(document.activeElement).toBe(h1('Накладные')));
    (document.activeElement as HTMLElement).blur();
    const location = TestBed.inject(Location);
    fixture.ngZone!.run(() => location.back());
    await waitFor(() => expect(document.activeElement).toBe(h1('Партии')));
    fixture.ngZone!.run(() => location.forward());
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

  it('a redirect at start-up counts as the first load', async () => {
    server.use(contractResponse('refreshToken', { status: 401 }));
    renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Вход' });
    expect(document.activeElement).toBe(document.body);
  });

  it('a query-only change does not move focus', async () => {
    const { router, fixture } = renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    const link = document.querySelector('.at-sidebar a[href="/batches"]') as HTMLElement;
    link.focus();
    await fixture.ngZone!.run(() => router.navigateByUrl('/batches?page=2'));
    await fixture.whenStable();
    expect(document.activeElement).toBe(link);
  });

  it('a new id on the same route (/fields/1 → /fields/2) moves focus', async () => {
    const { router, fixture } = renderApp('/fields/1');
    await screen.findByRole('heading', { level: 1, name: 'Поле' });
    await fixture.ngZone!.run(() => router.navigateByUrl('/fields/2'));
    await waitFor(() => expect(document.activeElement).toBe(h1('Поле')));
  });

  it('a pick in «Ещё» keeps focus on «Ещё» (README), the next navigation moves it again', async () => {
    const { router, fixture } = renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    const more = screen.getByRole('button', { name: 'Ещё', hidden: true });
    await userEvent.click(more);
    await userEvent.click(screen.getByRole('link', { name: 'Профиль', hidden: true }));
    await screen.findByRole('heading', { level: 1, name: 'Профиль' });
    await fixture.whenStable();
    expect(document.activeElement).toBe(more);
    await fixture.ngZone!.run(() => router.navigateByUrl('/fields'));
    await waitFor(() => expect(document.activeElement).toBe(h1('Поля')));
  });
});

describe('a cancelled navigation', () => {
  it('back on the current section (a pending navigation elsewhere superseded) focuses its title', async () => {
    const { router, fixture } = renderApp('/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    const sub = router.events.subscribe((e) => {
      if (e instanceof RoutesRecognized && e.url === '/fields') void router.navigateByUrl('/batches');
    });
    await fixture.ngZone!.run(() => router.navigateByUrl('/fields'));
    sub.unsubscribe();
    await waitFor(() => expect(document.activeElement).toBe(h1('Партии')));
    expect(router.url).toBe('/batches');
    expect(TestBed.inject(Location).path()).toBe('/batches');
  });
});
