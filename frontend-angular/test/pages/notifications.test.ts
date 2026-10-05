import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { FakeEventSource, renderApp } from '../app/renderApp';
import { expectNoLeakedInputs } from '../ui/leaks';

const me = () => contractExample('getMe').body as Record<string, unknown>;
const asMe = (patch: Record<string, unknown>) => contractResponse('getMe', { body: { ...me(), ...patch } });

const searchOf = (u: string) => (u.includes('?') ? '?' + u.split('?')[1] : '');

const hex = (n: number) => n.toString(16).padStart(12, '0');
const note = (seq: number, isRead = false, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});
const pageOf = (items: unknown[], total = items.length, page = 1) => ({ items, page, size: 20, total });

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
  type: `/problems/${code.toLowerCase().replace(/_/g, '-')}`,
  title: code,
  status,
  code,
  ...extra,
});

function alertText(): string {
  return [...document.querySelectorAll('.at-toast-region[role="alert"] .at-toast__text')]
    .map((n) => n.textContent)
    .join('|');
}

async function open(path = '/notifications') {
  const utils = renderApp(path);
  await screen.findByRole('heading', { level: 1, name: 'Уведомления' });
  return utils;
}

describe('/notifications', () => {
  it('lists the newest first with title, text, state and a link to what it is about', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      contractResponse('listNotifications', {
        body: pageOf([note(12), note(11, true)]),
        onRequest: (r) => void (query = new URL(r.url).searchParams),
      }),
    );
    await open();
    const link = await screen.findByRole('link', { name: 'Изъять партию AT-2026-000012' });
    expect(link).toHaveAttribute('href', '/recall-tasks');
    expect(
      screen.getByText('Партия AT-2026-000012 отозвана: подтвердите изъятие до 25.09.2026 15:00'),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Новое')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Прочитано')).toBeInTheDocument();
    expect(query!.get('sort')).toBe('seq,desc');
    expect(query!.get('page')).toBe('1');
    expect(query!.has('isRead')).toBe(false);
    expectNoLeakedInputs(document.body);
  });

  it('links only to screens of the viewer’s role (INSPECTOR: the recall card)', async () => {
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      contractResponse('listNotifications', { body: pageOf([note(5)]) }),
    );
    await open();
    expect(await screen.findByRole('link', { name: 'Изъять партию AT-2026-000005' })).toHaveAttribute(
      'href',
      '/recalls/4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d',
    );
  });

  it('the «Непрочитанные» tab asks for isRead=false and lives in ?tab=', async () => {
    const seen: (string | null)[] = [];
    server.use(
      contractResponse('listNotifications', {
        body: pageOf([note(3)]),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams.get('isRead')),
      }),
    );
    const { url } = await open();
    await screen.findByRole('link', { name: 'Изъять партию AT-2026-000003' });
    await userEvent.click(screen.getByRole('tab', { name: /Непрочитанные/ }));
    await waitFor(() => expect(seen.at(-1)).toBe('false'));
    expect(searchOf(url())).toBe('?tab=unread');
  });

  it('pages come from ?page= and the pagination keeps the tab', async () => {
    let page: string | null = null;
    server.use(
      contractResponse('listNotifications', {
        body: pageOf([note(1)], 45, 2),
        onRequest: (r) => void (page = new URL(r.url).searchParams.get('page')),
      }),
    );
    await open('/notifications?tab=unread&page=2');
    await screen.findByRole('link', { name: 'Изъять партию AT-2026-000001' });
    expect(page).toBe('2');
    expect(screen.getByText('21–40 из 45')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '3' })).toHaveAttribute(
      'href',
      '/notifications?tab=unread&page=3',
    );
  });

  it('marks the selected ones read by ids; the bell takes the new count', async () => {
    let body: unknown;
    server.use(
      contractResponse('listNotifications', { body: pageOf([note(12), note(11)]) }),
      contractResponse('markNotificationsRead', {
        body: { count: 1 },
        onRequest: async (r) => void (body = await r.json()),
      }),
    );
    await open();
    FakeEventSource.last!.emit('unread', { count: 2 });
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Выбрать «Изъять партию AT-2026-000011»' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Отметить прочитанным' }));
    await waitFor(() => expect(body).toEqual({ ids: ['b7c8d9e0-f1a2-4b3c-8d4e-00000000000b'] }));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Уведомления, непрочитанных: 1' })).toBeInTheDocument(),
    );
  });

  it('«mark all read» sends upToSeq of the newest shown', async () => {
    let body: unknown;
    server.use(
      contractResponse('listNotifications', { body: pageOf([note(40), note(39, true), note(7)]) }),
      contractResponse('markNotificationsRead', {
        body: { count: 0 },
        onRequest: async (r) => void (body = await r.json()),
      }),
    );
    await open();
    await screen.findByRole('link', { name: 'Изъять партию AT-2026-000040' });
    await userEvent.click(screen.getByRole('button', { name: 'Отметить все прочитанными' }));
    await waitFor(() => expect(body).toEqual({ upToSeq: 40 }));
  });

  it('«mark all read» away from the first page still marks everything (asks for the newest seq)', async () => {
    let body: unknown;
    server.use(
      http.get(`${API_BASE}/notifications`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        if (q.get('size') === '1' && q.get('page') === '1' && !q.has('isRead'))
          return HttpResponse.json({ ...pageOf([note(77)], 45, 1), size: 1 });
        return HttpResponse.json(pageOf([note(9)], 45, 2));
      }),
      contractResponse('markNotificationsRead', {
        body: { count: 0 },
        onRequest: async (r) => void (body = await r.json()),
      }),
    );
    await open('/notifications?tab=unread&page=2');
    await screen.findByRole('link', { name: 'Изъять партию AT-2026-000009' });
    await userEvent.click(screen.getByRole('button', { name: 'Отметить все прочитанными' }));
    await waitFor(() => expect(body).toEqual({ upToSeq: 77 }));
  });

  it('the selection is cleared on another page', async () => {
    server.use(contractResponse('listNotifications', { body: pageOf([note(12)], 45, 1) }));
    await open();
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Выбрать «Изъять партию AT-2026-000012»' }),
    );
    expect(screen.getByRole('button', { name: 'Отметить прочитанным' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: '2' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Отметить прочитанным' })).not.toBeInTheDocument(),
    );
  });

  it('400 of mark-read (an id that is gone) is shown as the message', async () => {
    server.use(
      contractResponse('listNotifications', { body: pageOf([note(12)]) }),
      contractResponse('markNotificationsRead', {
        status: 400,
        body: problem(400, 'VALIDATION', { errors: { 'ids[0]': ['validation.notFound'] } }),
      }),
    );
    await open();
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Выбрать «Изъять партию AT-2026-000012»' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Отметить прочитанным' }));
    await waitFor(() => expect(alertText()).toBe('Запись не найдена'));
  });

  it('429 of mark-read says when to retry', async () => {
    server.use(
      contractResponse('listNotifications', { body: pageOf([note(12)]) }),
      contractResponse('markNotificationsRead', { status: 429, headers: { 'Retry-After': '7' } }),
    );
    await open();
    await screen.findByRole('link', { name: 'Изъять партию AT-2026-000012' });
    await userEvent.click(screen.getByRole('button', { name: 'Отметить все прочитанными' }));
    await waitFor(() =>
      expect(document.querySelector('.at-toast-region[aria-live] .at-toast__text')?.textContent).toBe(
        'Слишком много попыток — повторите через 7 с',
      ),
    );
  });

  it('empty: illustration, one line, one action', async () => {
    server.use(contractResponse('listNotifications', { body: pageOf([]) }));
    await open();
    expect(await screen.findByText('Уведомлений пока нет.')).toBeInTheDocument();
    expect(document.querySelector('.at-empty svg.at-empty__art')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'На главную' })).toHaveAttribute('href', '/');
  });

  it('empty unread tab offers all notifications', async () => {
    server.use(contractResponse('listNotifications', { body: pageOf([]) }));
    const { url } = await open('/notifications?tab=unread');
    await userEvent.click(await screen.findByRole('button', { name: 'Все уведомления' }));
    await waitFor(() => expect(searchOf(url())).toBe(''));
  });

  it.each([
    [400, {}],
    [429, { headers: { 'Retry-After': '5' } }],
  ])('a failed list (%s) shows the error with a retry', async (status, extra) => {
    let fail = true;
    server.use(
      contractResponse('listNotifications', {
        status,
        ...extra,
        onRequest: () => {
          if (!fail) throw new Error('unreachable');
        },
      }),
    );
    await open();
    expect(await screen.findByText('Уведомления не загрузились.')).toBeInTheDocument();
    fail = false;
    server.resetHandlers();
    server.use(contractResponse('listNotifications', { body: pageOf([note(2)]) }));
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('link', { name: 'Изъять партию AT-2026-000002' })).toBeInTheDocument();
  });

  it('a live `notification` event refreshes the list', async () => {
    server.use(contractResponse('listNotifications', { body: pageOf([note(1)]) }));
    await open();
    await screen.findByRole('link', { name: 'Изъять партию AT-2026-000001' });
    server.use(contractResponse('listNotifications', { body: pageOf([note(2), note(1)]) }));
    FakeEventSource.last!.emit('notification', note(2), '2');
    expect(await screen.findByRole('link', { name: 'Изъять партию AT-2026-000002' })).toBeInTheDocument();
  });
});
