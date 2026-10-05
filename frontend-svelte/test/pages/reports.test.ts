import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { server } from '../setup';
import { contractResponse, operation, type Json } from '../msw/fromContract';
import { asMe, dictionaries, pageOf, problem, PRODUCTS, toastText } from '../msw/data';
import { renderApp } from '../app/renderApp';
import { REPORT_ACCESS, reportTypes } from '../../src/lib/pages/reports/reports';
import { formatLocalDateTime } from '@agrotrace/i18n';

const INSPECTION = {
  id: 'f1a2b3c4-5000-4000-8000-000000000900',
  name: 'Инспекция',
  type: 'AUTHORITY',
  logoUrl: null,
};
const asInspector = () => asMe({ roles: ['INSPECTOR'], organization: INSPECTION });

async function open(path: string, title: string) {
  const utils = await renderApp(path);
  await screen.findByRole('heading', { level: 1, name: title });
  return utils;
}
async function openFilters() {
  const toggle = document.querySelector<HTMLElement>('.at-page__filters-toggle');
  if (toggle && !toggle.closest('details')!.open) await userEvent.click(toggle);
}

const auditEntry = (): Json => {
  return {
    id: 104233,
    actor: {
      id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      fullName: 'Петров Иван Сергеевич',
      organization: {
        id: '0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10',
        name: 'КФХ Петров',
        type: 'FARM',
        logoUrl: null,
      },
    },
    action: 'sendWaybill',
    entityType: 'batch',
    entityId: '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c',
    diff: { status: ['Approved', 'InTransit'], version: [2, 3] },
    ip: '172.18.0.1',
    backend: 'laravel',
    requestId: '4f1c2a7e-9b3d-4e5f-8a6b-0c1d2e3f4a5b',
    createdAt: '2026-08-01T08:15:00Z',
  };
};

describe('/admin/audit', () => {
  it('filters go to the URL and the request; an author link narrows the log; the diff shows before and after', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asInspector(),
      contractResponse('listAuditLog', {
        body: pageOf([auditEntry()]),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    await open('/admin/audit', 'Журнал аудита');
    expect(await screen.findByText('sendWaybill')).toBeInTheDocument();
    await openFilters();
    await userEvent.selectOptions(screen.getByLabelText('Запись'), 'Партия');
    await waitFor(() => expect(seen.at(-1)!.get('entityType')).toBe('batch'));
    await userEvent.selectOptions(screen.getByLabelText('Реализация'), 'Laravel');
    await waitFor(() => expect(seen.at(-1)!.get('backend')).toBe('laravel'));
    await userEvent.click(screen.getByRole('link', { name: 'Записи автора Петров Иван Сергеевич' }));
    await waitFor(() => expect(seen.at(-1)!.get('actorId')).toBe('1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'));
    expect(new URLSearchParams(location.search).get('entityType')).toBe('batch');

    await userEvent.click(screen.getByRole('button', { name: 'Изменения записи журнала 104233' }));
    const dialog = screen.getByRole('dialog', { name: 'Партия: Отгрузка накладной' });
    const row = within(within(dialog).getByRole('table', { name: 'Изменённые поля' }))
      .getByText('status')
      .closest('tr')!;
    expect(within(row).getByText('Статус')).toBeInTheDocument();
    expect(within(row).getByText('Допущена')).toBeInTheDocument();
    expect(within(row).getByText('В пути')).toBeInTheDocument();
    expect(within(dialog).getByText('172.18.0.1')).toBeInTheDocument();
  });

  it('the diff of a deleted norm: every field by its label, instants and dates readable', async () => {
    const at = '2026-08-01T08:15:00Z';
    server.use(
      asInspector(),
      dictionaries(),
      contractResponse('listAuditLog', {
        body: pageOf([
          {
            ...(auditEntry() as Record<string, Json>),
            action: 'deleteDictionaryEntry',
            entityType: 'norm',
            diff: {
              productId: [PRODUCTS[0]!.id, null],
              indicatorId: ['4b7e1c2a-0d3f-4e5a-9b6c-7d8e9f0a1b2c', null],
              maxValue: ['0.010000', null],
              regionCode: ['33', null],
              deletedAt: [null, at],
              issueDate: ['2026-08-14', null],
              isOrgAdmin: [false, true],
            },
          },
        ]),
      }),
    );
    await open('/admin/audit', 'Журнал аудита');
    await userEvent.click(await screen.findByRole('button', { name: 'Изменения записи журнала 104233' }));
    expect(screen.getByRole('dialog', { name: 'Норматив: Удаление записи справочника' })).toBeInTheDocument();
    const table = within(screen.getByRole('dialog')).getByRole('table', { name: 'Изменённые поля' });
    const row = (api: string) => within(table).getByText(api).closest('tr')!;
    expect(within(row('productId')).getByText('Продукт')).toBeInTheDocument();
    expect(within(row('maxValue')).getByText('Максимальное значение')).toBeInTheDocument();
    expect(await within(row('productId')).findByText(PRODUCTS[0]!.name)).toBeInTheDocument();
    expect(within(row('indicatorId')).getByText('4b7e1c2a-0d3f-4e5a-9b6c-7d8e9f0a1b2c')).toBeInTheDocument();
    expect(within(row('regionCode')).getByText('Владимирская область')).toBeInTheDocument();
    expect(within(row('maxValue')).getByText('0,01')).toBeInTheDocument();
    expect(within(row('deletedAt')).getByText('Удалено')).toBeInTheDocument();
    expect(within(row('deletedAt')).getByText(formatLocalDateTime(at, 'ru'))).toBeInTheDocument();
    expect(within(row('deletedAt')).queryByText(at)).toBeNull();
    expect(within(row('issueDate')).getByText('14.08.2026')).toBeInTheDocument();
    expect(within(row('isOrgAdmin')).getByText('нет')).toBeInTheDocument();
    expect(within(row('isOrgAdmin')).getByText('да')).toBeInTheDocument();
  });

  it('a bad link is cleaned before the request (unknown entity type, malformed id)', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asInspector(),
      contractResponse('listAuditLog', {
        body: pageOf([]),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    await open('/admin/audit?entityType=cow&entityId=nope&backend=express', 'Журнал аудита');
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.every((p) => !p.has('entityType') && !p.has('entityId'))).toBe(true);
    expect(seen.at(-1)!.get('backend')).toBe('express');
  });
});

describe('reports', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the access table is the contract’s x-report-access', () => {
    expect(REPORT_ACCESS).toEqual(operation('downloadReport').op['x-report-access']);
  });

  it('types by role: INSPECTOR all; a FARMER head batches and org (own); an employee none', () => {
    expect(reportTypes(['INSPECTOR'], false).map((x) => x.type)).toHaveLength(6);
    expect(reportTypes(['FARMER'], true)).toEqual([
      { type: 'batches', head: true },
      { type: 'org', head: true },
    ]);
    expect(reportTypes(['FARMER'], false)).toEqual([]);
  });

  it('downloads the file under the server’s name, with the period and format asked', async () => {
    let url: URL | null = null;
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    server.use(
      asInspector(),
      contractResponse('downloadReport', {
        headers: {
          'Content-Disposition':
            'attachment; filename="agrotrace-recalls_2026-09-01_2026-09-24.pdf"; filename*=UTF-8\'\'agrotrace-recalls_2026-09-01_2026-09-24.pdf',
        },
        onRequest: (r) => void (url = new URL(r.url)),
      }),
    );
    await open('/reports', 'Отчёты');
    await userEvent.selectOptions(screen.getByLabelText('Отчёт'), 'Отзывы');
    await userEvent.click(screen.getByRole('radio', { name: 'PDF' }));
    await userEvent.click(screen.getByRole('button', { name: 'Скачать отчёт' }));
    await waitFor(() => expect(saved).toEqual(['agrotrace-recalls_2026-09-01_2026-09-24.pdf']));
    const u = url as unknown as URL;
    expect(u.pathname).toMatch(/\/reports\/recalls$/);
    expect(u.searchParams.get('format')).toBe('pdf');
    const from = Date.parse(`${u.searchParams.get('from')}T00:00:00Z`);
    const to = Date.parse(`${u.searchParams.get('to')}T00:00:00Z`);
    expect((to - from) / 86_400_000).toBe(29);
    await waitFor(() =>
      expect(toastText('polite')).toContain('Отчёт agrotrace-recalls_2026-09-01_2026-09-24.pdf скачан'),
    );
  });

  it('a period over 366 days is refused before the request', async () => {
    let asked = false;
    server.use(asInspector(), contractResponse('downloadReport', { onRequest: () => void (asked = true) }));
    await open('/reports', 'Отчёты');
    const from = screen.getByLabelText('Период с');
    await userEvent.clear(from);
    await userEvent.type(from, '01.01.2024');
    await userEvent.click(screen.getByRole('button', { name: 'Скачать отчёт' }));
    expect(await screen.findByLabelText('Период по')).toHaveAccessibleDescription(
      'Период — не больше 366 дней',
    );
    expect(asked).toBe(false);
  });

  it('a recall report needs the recall; a server error is said on its field', async () => {
    server.use(
      asInspector(),
      contractResponse('downloadReport', {
        status: 400,
        body: problem(400, 'VALIDATION', { errors: { type: ['validation.report.tooManyRows'] } }),
      }),
    );
    await open('/reports?type=recall', 'Отчёты');
    expect(screen.getByLabelText('Отчёт')).toHaveValue('recall');
    expect(screen.queryByLabelText('Период с')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Скачать отчёт' }));
    expect(
      await screen.findByRole('combobox', { name: 'Отзыв (код исходной партии)' }),
    ).toHaveAccessibleDescription('Обязательное поле');
    await userEvent.selectOptions(screen.getByLabelText('Отчёт'), 'Партии');
    await userEvent.click(screen.getByRole('button', { name: 'Скачать отчёт' }));
    expect(await screen.findByLabelText('Отчёт')).toHaveAccessibleDescription(
      'Слишком много строк для отчёта',
    );
  });

  it('a FARMER head: batches and the own organization, no organization to choose', async () => {
    let url: URL | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    server.use(contractResponse('downloadReport', { onRequest: (r) => void (url = new URL(r.url)) }));
    await open('/reports', 'Отчёты');
    const select = screen.getByLabelText('Отчёт');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Партии', 'Сводка по организации']);
    await userEvent.selectOptions(select, 'Сводка по организации');
    expect(screen.queryByRole('combobox', { name: 'Организация' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Скачать отчёт' }));
    await waitFor(() => expect((url as unknown as URL)?.pathname).toMatch(/\/reports\/org$/));
    expect((url as unknown as URL).searchParams.has('id')).toBe(false);
  });
});
