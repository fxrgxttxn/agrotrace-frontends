import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { server } from '../setup';
import { http, HttpResponse } from 'msw';
import { API_BASE, contractExample, contractResponse, type Json } from '../msw/fromContract';
import { asMe } from '../msw/data';
import { renderApp } from '../app/renderApp';
import { router } from '../kit/router.svelte';
import { mountBars } from '../../src/lib/charts/echarts';

const mounted = vi.mocked(mountBars);
beforeEach(() => mounted.mockClear());

const inspector = () => contractExample('getDashboard', 200, 'inspector').body as Json;
const lab = () => contractExample('getDashboard', 200, 'lab').body as Json;
const org = () => ({
  scope: 'org',
  period: { from: '2026-08-26', to: '2026-09-24' },
  organization: {
    id: '0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10',
    name: 'КФХ Петров',
    type: 'FARM',
    logoUrl: null,
  },
  byStatus: [
    ['Created', 0],
    ['OnTest', 1],
    ['Approved', 3],
    ['InTransit', 1],
    ['Accepted', 0],
    ['Processed', 0],
    ['OnSale', 0],
    ['Sold', 0],
    ['Blocked', 0],
    ['Recalled', 1],
    ['WrittenOff', 2],
  ].map(([status, count]) => ({ status, count })),
  labResults: { pass: 7, fail: 1 },
  openTasks: 2,
  overdueTasks: 1,
});

async function open(path = '/') {
  const utils = await renderApp(path);
  await screen.findByRole('heading', { level: 1, name: 'Панель' });
  return utils;
}
const metric = (label: string) =>
  screen.getByText(label, { selector: '.at-metric__label' }).closest('.at-metric')!;
const canvas = (title: string) =>
  screen
    .getByRole('heading', { level: 2, name: title })
    .closest('.at-card')!
    .querySelector('.at-chart__canvas')!;

describe('/ — inspector', () => {
  it('scope=inspector: metrics, rejected shares and regions as charts with their tables', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      contractResponse('getDashboard', {
        body: inspector(),
        onRequest: (r) => void (query = new URL(r.url).searchParams),
      }),
    );
    await open();
    await screen.findByText('Партий за период');
    expect(query!.get('scope')).toBe('inspector');
    expect(query!.has('from')).toBe(false);
    expect(metric('Партий за период')).toHaveTextContent('40');
    expect(metric('Активные отзывы')).toHaveTextContent('1');
    expect(metric('Среднее время отзыва')).toHaveTextContent('18,25ч');
    expect(metric('Нарушений за период')).toHaveTextContent('1');
    expect(screen.getByLabelText('Период с')).toHaveValue('26.08.2026');
    expect(screen.getByLabelText('Период по')).toHaveValue('24.09.2026');

    expect(canvas('Доля брака по продуктам')).toHaveAttribute(
      'aria-label',
      'Доля брака по продуктам: Пшеница озимая — 12,50%',
    );
    expect(canvas('Доля брака по хозяйствам')).toHaveAttribute(
      'aria-label',
      'Доля брака по хозяйствам: КФХ Петров — 12,50%',
    );
    expect(canvas('Нарушения по регионам')).toHaveAttribute(
      'aria-label',
      'Нарушения по регионам: Краснодарский край — 1',
    );
    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(3));
    expect(mounted.mock.calls[0]![1]).toEqual([
      {
        key: '7a2b4c6d-8e0f-4a1b-9c3d-5e7f9a1b3c5d',
        label: 'Пшеница озимая',
        value: 12.5,
        display: '12,50%',
      },
    ]);

    const card = screen
      .getByRole('heading', { level: 2, name: 'Доля брака по продуктам' })
      .closest<HTMLElement>('.at-card')!;
    const details = card.querySelector('details.at-chart__data')!;
    expect(details).not.toHaveAttribute('open');
    await userEvent.click(within(card).getByText('Таблица значений'));
    const table = within(card).getByRole('table', { name: 'Доля брака по продуктам' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Продукт', 'Проверено', 'С превышением', 'Доля брака, %']);
    expect(
      within(table)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['Пшеница озимая', '8', '1', '12,50']);
  });

  it('ADMIN sees the inspector scope; no average recall — «—»; no shares — one line', async () => {
    let scope: string | null = null;
    server.use(
      asMe({ roles: ['ADMIN'] }),
      contractResponse('getDashboard', {
        body: { ...inspector(), avgRecallHours: null, rejectedShare: { byProduct: [], byFarm: [] } },
        onRequest: (r) => void (scope = new URL(r.url).searchParams.get('scope')),
      }),
    );
    await open();
    await screen.findByText('Среднее время отзыва');
    expect(scope).toBe('inspector');
    expect(metric('Среднее время отзыва')).toHaveTextContent('—');
    const card = screen
      .getByRole('heading', { level: 2, name: 'Доля брака по продуктам' })
      .closest('.at-card')!;
    expect(within(card as HTMLElement).getByText('За период данных нет.')).toHaveClass('at-chart__empty');
    expect(card.querySelector('.at-chart')).toBeNull();
  });

  it('regions: only non-zero, most first; more than 10 — nine and «Другие» with the rest; the table has all', async () => {
    const regions = Array.from({ length: 13 }, (_, i) => ({
      code: String(10 + i),
      name: `Регион ${10 + i}`,
      count: i === 12 ? 0 : i + 1,
    }));
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      contractResponse('getDashboard', { body: { ...inspector(), violationsByRegion: regions } }),
    );
    await open();
    await screen.findByText('Нарушений за период');
    expect(metric('Нарушений за период')).toHaveTextContent('78');
    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(3));
    const bars = [...mounted.mock.calls[2]![1]];
    expect(bars.map((b) => [b.label, b.value])).toEqual([
      ['Регион 21', 12],
      ['Регион 20', 11],
      ['Регион 19', 10],
      ['Регион 18', 9],
      ['Регион 17', 8],
      ['Регион 16', 7],
      ['Регион 15', 6],
      ['Регион 14', 5],
      ['Регион 13', 4],
      ['Другие', 6],
    ]);
    const card = screen
      .getByRole('heading', { level: 2, name: 'Нарушения по регионам' })
      .closest('.at-card')!;
    expect(within(card as HTMLElement).getAllByRole('row')).toHaveLength(13);
  });

  it('the period goes to the URL and the request; a range the server rejects offers «Сбросить фильтры»', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      contractResponse('getDashboard', {
        body: inspector(),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    await open('/?from=2026-09-01&to=bad');
    await screen.findByText('Партий за период');
    expect(seen.at(-1)!.get('from')).toBe('2026-09-01');
    expect(seen.at(-1)!.has('to')).toBe(false);
    expect(location.search).toBe('?from=2026-09-01');
    expect(screen.getByLabelText('Период с')).toHaveValue('01.09.2026');
    await userEvent.clear(screen.getByLabelText('Период по'));
    await userEvent.type(screen.getByLabelText('Период по'), '20.09.2026');
    await waitFor(() => expect(seen.at(-1)!.get('to')).toBe('2026-09-20'));

    server.use(contractResponse('getDashboard', { status: 400 }));
    await userEvent.clear(screen.getByLabelText('Период с'));
    await userEvent.type(screen.getByLabelText('Период с'), '01.01.2024');
    await userEvent.click(await screen.findByRole('button', { name: 'Сбросить фильтры' }));
    await waitFor(() => expect(location.search).toBe(''));
    expect(screen.getByRole('heading', { level: 1, name: 'Панель' })).toHaveFocus();
  });

  it('a window longer than 366 days is refused before any request, with the contract text', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      contractResponse('getDashboard', {
        body: inspector(),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    await open('/?from=2025-01-01&to=2026-01-02');
    expect(await screen.findByText('Слишком длинный диапазон дат')).toBeInTheDocument();
    expect(seen).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));
    await waitFor(() => expect(location.search).toBe(''));
    await waitFor(() => expect(seen).toHaveLength(1));
    await router.goto('/?from=2025-01-01&to=2026-01-01');
    await waitFor(() => expect(seen.at(-1)!.get('to')).toBe('2026-01-01'));
  });

  it('403: said without «Повторить» (a retry cannot help)', async () => {
    server.use(asMe({ roles: ['INSPECTOR'] }), contractResponse('getDashboard', { status: 403 }));
    await open();
    expect(await screen.findByText('Недостаточно прав для этого действия')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
  });

  it('below 768 px the applied period is shown next to «Фильтры»', async () => {
    server.use(asMe({ roles: ['INSPECTOR'] }), contractResponse('getDashboard', { body: inspector() }));
    await open();
    expect(await screen.findByText('26.08.2026 — 24.09.2026')).toHaveClass('at-page__note');
  });

  it('a chart that could not be drawn says so and offers «Повторить»', async () => {
    server.use(asMe({ roles: ['INSPECTOR'] }), contractResponse('getDashboard', { body: inspector() }));
    mounted.mockImplementationOnce(() => {
      throw new Error('chunk failed');
    });
    await open();
    const card = (
      await screen.findByRole('heading', { level: 2, name: 'Доля брака по продуктам' })
    ).closest<HTMLElement>('.at-card')!;
    expect(await within(card).findByRole('alert')).toHaveTextContent('График не загрузился.');
    await userEvent.click(within(card).getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(within(card).queryByRole('alert')).toBeNull());
    expect(card.querySelector('.at-chart__canvas[role="img"]')).not.toBeNull();
  });

  it('a failed load (network): the text and «Повторить»', async () => {
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      http.get(`${API_BASE}/analytics/dashboard`, () => HttpResponse.error()),
    );
    await open();
    expect(await screen.findByText('Показатели не загрузились.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });
});

describe('/ — organization and laboratory', () => {
  it('FARMER: scope=org; batches by status (all 11), lab results, recall tasks with the overdue ones', async () => {
    let scope: string | null = null;
    server.use(
      contractResponse('getDashboard', {
        body: org(),
        onRequest: (r) => void (scope = new URL(r.url).searchParams.get('scope')),
      }),
    );
    await open();
    await screen.findByText('Партий у организации');
    expect(scope).toBe('org');
    expect(metric('Партий у организации')).toHaveTextContent('8');
    expect(metric('Анализы в норме')).toHaveTextContent('7');
    expect(metric('Анализы с превышением')).toHaveTextContent('1');
    expect(metric('Задачи отзыва')).toHaveTextContent('2');
    expect(metric('Задачи отзыва')).toHaveTextContent('из них просрочено: 1');
    await waitFor(() => expect(mounted).toHaveBeenCalledTimes(1));
    const bars = [...mounted.mock.calls[0]![1]];
    expect(bars).toHaveLength(11);
    expect(bars[0]).toMatchObject({ label: 'Создана', value: 0 });
    expect(bars[10]).toMatchObject({ label: 'Списана', value: 2 });
    expect(canvas('Партии по статусам').getAttribute('aria-label')).toContain('Допущена — 3');
  });

  it('LAB: scope=lab; the queue, overdue, completed, failed, average time; no chart', async () => {
    let scope: string | null = null;
    server.use(
      asMe({ roles: ['LAB'] }),
      contractResponse('getDashboard', {
        body: lab(),
        onRequest: (r) => void (scope = new URL(r.url).searchParams.get('scope')),
      }),
    );
    await open();
    await screen.findByText('В очереди');
    expect(scope).toBe('lab');
    expect(metric('В очереди')).toHaveTextContent('4');
    expect(metric('Просрочено')).toHaveTextContent('1');
    expect(metric('Завершено за период')).toHaveTextContent('12');
    expect(metric('С превышением за период')).toHaveTextContent('1');
    expect(metric('Среднее время анализа')).toHaveTextContent('52,40ч');
    expect(document.querySelector('.at-chart')).toBeNull();
    expect(mounted).not.toHaveBeenCalled();
  });
});
