import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '../setup';
import { contractExample, contractResponse } from '../msw/fromContract';
import { asMe, pageOf, problem, toastText } from '../msw/data';
import { renderApp } from '../app/renderApp';

// Waybills (FR-PROD-05, BR-01/06/07/11, R4) on the contract's MSW handlers: the list (direction/status/filters in the
// URL, INSPECTOR read-only), the draft form (receiver from the organizations directory, batches of the own stock,
// one Idempotency-Key per form, IN_PROGRESS repeated by the client), the card (send with If-Match, BR-01 text,
// acceptance with the live BR-07 discrepancy from @agrotrace/domain, reject with the repeated number, delete,
// VERSION_CONFLICT → re-read).

const WAYBILL_ID = '7e9a1c3e-5b7d-4f9b-a1c3-5e7a9c1e3b5d';
const BATCH_ID = '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c';
const MUKOMOL = {
  id: '4b6d8f0a-2c4e-4a6b-8d0f-1a3c5e7a9b1d',
  name: 'ООО «Кубанский мукомол»',
  type: 'PROCESSOR',
  logoUrl: null,
};
const asProcessor = () => asMe({ roles: ['PROCESSOR'], organization: MUKOMOL });
const sentWaybill = (extra: Record<string, unknown> = {}) => ({
  ...(contractExample('getWaybill').body as Record<string, unknown>),
  ...extra,
});
const draft = (extra: Record<string, unknown> = {}) => ({
  ...(contractExample('createWaybill').body as Record<string, unknown>),
  ...extra,
});

async function open(path: string, title: string | RegExp) {
  const utils = renderApp(path);
  await screen.findByRole('heading', { level: 1, name: title });
  return utils;
}
async function openFilters() {
  const toggle = document.querySelector<HTMLElement>('.at-page__filters-toggle');
  if (toggle && !toggle.closest('details')!.open) await userEvent.click(toggle);
}

describe('/waybills', () => {
  it('the list: number link with its batches, status, sides, declared mass; FARMER may create', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      contractResponse('listWaybills', { onRequest: (r) => void (query = new URL(r.url).searchParams) }),
    );
    await open('/waybills', 'Накладные');
    const link = await screen.findByRole('link', { name: 'WB-2026-000017' });
    expect(link).toHaveAttribute('href', `/waybills/${WAYBILL_ID}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText('1 партия')).toBeInTheDocument();
    expect(within(row).getByText('Черновик')).toHaveAttribute('data-tone', 'neutral');
    expect(within(row).getByText('КФХ Петров')).toBeInTheDocument();
    expect(within(row).getByText('ООО «Кубанский мукомол»')).toBeInTheDocument();
    expect(within(row).getByText('12 480,000')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Создать накладную' })[0]).toHaveAttribute(
      'href',
      '/waybills/new',
    );
    expect(query!.has('direction')).toBe(false);
  });

  it('direction (from the batch card link) and status go to the server and stay in the URL', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      contractResponse('listWaybills', { onRequest: (r) => void seen.push(new URL(r.url).searchParams) }),
    );
    const { router } = await open('/waybills?direction=incoming', 'Накладные');
    await screen.findByRole('link', { name: 'WB-2026-000017' });
    expect(seen.at(-1)!.get('direction')).toBe('incoming');
    await openFilters();
    expect(screen.getByLabelText('Направление')).toHaveValue('incoming');
    await userEvent.selectOptions(screen.getByLabelText('Статус'), 'Отправлена');
    await waitFor(() => expect(seen.at(-1)!.getAll('status')).toEqual(['SENT']));
    expect(new URLSearchParams(router.state.location.search).get('direction')).toBe('incoming');
  });

  it('INSPECTOR: read-only, no direction (R51), the counterparty filter; no create button', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      contractResponse('listWaybills', {
        body: pageOf([sentWaybill()]),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    await open('/waybills?direction=outgoing', 'Накладные');
    await screen.findByRole('link', { name: 'WB-2026-000017' });
    expect(seen.at(-1)!.has('direction')).toBe(false);
    await openFilters();
    expect(screen.queryByLabelText('Направление')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Контрагент' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Создать накладную' })).toBeNull();
  });

  it('empty and filtered-empty states', async () => {
    server.use(contractResponse('listWaybills', { body: pageOf([]) }));
    const { router } = await open('/waybills', 'Накладные');
    expect(await screen.findByText('Накладных пока нет.')).toBeInTheDocument();
    router.navigate('/waybills?status=SENT');
    expect(await screen.findByText('Ничего не найдено.')).toBeInTheDocument();
  });
});

describe('/waybills/new', () => {
  async function pickReceiver() {
    await userEvent.type(await screen.findByRole('combobox', { name: 'Получатель' }), 'Куб');
    const list = await screen.findByRole('listbox', { name: 'Получатель' });
    await userEvent.click((await within(list).findAllByRole('option'))[0]!);
  }

  it('creates a draft: receiver from the directory, the batch of the link preselected with its mass', async () => {
    let body: unknown = null;
    let key: string | null = null;
    let stockQuery: URLSearchParams | null = null;
    server.use(
      contractResponse('listBatches', { onRequest: (r) => void (stockQuery = new URL(r.url).searchParams) }),
      contractResponse('createWaybill', {
        onRequest: async (r) => {
          body = await r.json();
          key = r.headers.get('Idempotency-Key');
        },
      }),
    );
    const { router } = await open(`/waybills/new?batchId=${BATCH_ID}`, 'Новая накладная');
    expect(stockQuery!.get('holder')).toBe('me');
    expect(stockQuery!.getAll('status').sort()).toEqual(['Accepted', 'Approved']);
    expect(await screen.findByRole('checkbox', { name: 'Выбрать AT-2026-000123' })).toBeChecked();
    expect(screen.getByLabelText('Заявленная масса AT-2026-000123')).toHaveValue('12480,000');
    await pickReceiver();
    await userEvent.click(screen.getByRole('button', { name: 'Создать накладную' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/waybills/${WAYBILL_ID}`));
    expect(body).toEqual({
      receiverOrgId: MUKOMOL.id,
      items: [{ batchId: BATCH_ID, massDeclaredKg: '12480.000' }],
    });
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(toastText('polite')).toContain('Черновик WB-2026-000017 создан');
  });

  it('an empty form is marked without a request; a mass above the batch is caught before sending', async () => {
    let calls = 0;
    server.use(contractResponse('createWaybill', { onRequest: () => void calls++ }));
    await open('/waybills/new', 'Новая накладная');
    await userEvent.click(await screen.findByRole('button', { name: 'Создать накладную' }));
    expect(await screen.findByText('Выберите хотя бы одну партию')).toBeInTheDocument();
    expect(screen.getByText('Обязательное поле')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Выбрать AT-2026-000123' }));
    const mass = screen.getByLabelText('Заявленная масса AT-2026-000123');
    await userEvent.clear(mass);
    await userEvent.type(mass, '20000');
    await userEvent.click(screen.getByRole('button', { name: 'Создать накладную' }));
    expect(await screen.findByText('Масса превышает текущую массу партии')).toBeInTheDocument();
    expect(calls).toBe(0);
  });

  it('IDEMPOTENCY_KEY_IN_PROGRESS: the client repeats with the same key and gets the draft', async () => {
    const keys: (string | null)[] = [];
    server.use(
      contractResponse('createWaybill', {
        status: 409,
        example: 'idempotencyKeyInProgress',
        headers: { 'Retry-After': '1' },
        once: true,
        onRequest: (r) => void keys.push(r.headers.get('Idempotency-Key')),
      }),
      contractResponse('createWaybill', {
        onRequest: (r) => void keys.push(r.headers.get('Idempotency-Key')),
      }),
    );
    const { router } = await open(`/waybills/new?batchId=${BATCH_ID}`, 'Новая накладная');
    await screen.findByRole('checkbox', { name: 'Выбрать AT-2026-000123' });
    await pickReceiver();
    await userEvent.click(screen.getByRole('button', { name: 'Создать накладную' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/waybills/${WAYBILL_ID}`), {
      timeout: 5000,
    });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('400: errors by path under the row and the receiver; a new key after a definite answer', async () => {
    const keys: (string | null)[] = [];
    server.use(
      contractResponse('createWaybill', {
        status: 400,
        body: problem(400, 'VALIDATION', {
          errors: {
            receiverOrgId: ['validation.receiver.type'],
            'items[0].massDeclaredKg': ['validation.mass.exceedsBatch'],
          },
        }),
        onRequest: (r) => void keys.push(r.headers.get('Idempotency-Key')),
      }),
    );
    await open(`/waybills/new?batchId=${BATCH_ID}`, 'Новая накладная');
    await screen.findByRole('checkbox', { name: 'Выбрать AT-2026-000123' });
    await pickReceiver();
    await userEvent.click(screen.getByRole('button', { name: 'Создать накладную' }));
    expect(
      await screen.findByText('Получатель должен быть переработчиком или продавцом'),
    ).toBeInTheDocument();
    const mass = screen.getByLabelText('Заявленная масса AT-2026-000123');
    expect(mass).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(mass.getAttribute('aria-describedby')!)).toHaveTextContent(
      'Масса превышает текущую массу партии',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Создать накладную' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('nothing to ship: one line and one button', async () => {
    server.use(contractResponse('listBatches', { body: pageOf([]) }));
    await open('/waybills/new', 'Новая накладная');
    expect(await screen.findByText(/Отгружать пока нечего/)).toBeInTheDocument();
  });
});

describe('/waybills/:id', () => {
  it('receiver: live BR-07 discrepancy from the domain, the act becomes required; accept with If-Match', async () => {
    let body: unknown = null;
    let ifMatch: string | null = null;
    let key: string | null = null;
    server.use(
      asProcessor(),
      contractResponse('acceptWaybill', {
        body: sentWaybill({ status: 'ACCEPTED', version: 3, actions: [] }),
        onRequest: async (r) => {
          body = await r.json();
          ifMatch = r.headers.get('If-Match');
          key = r.headers.get('Idempotency-Key');
        },
      }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    expect(screen.getByRole('button', { name: 'Отказаться' })).toBeInTheDocument();
    const actual = await screen.findByLabelText('Фактическая масса AT-2026-000123');
    expect(actual).toHaveValue('12480,000');
    expect(screen.queryByLabelText('Акт расхождения AT-2026-000123')).toBeNull();
    await userEvent.clear(actual);
    await userEvent.type(actual, '12080');
    expect(await screen.findByText('Больше 2%: нужен акт')).toBeInTheDocument();
    expect(screen.getByText(/3,21%/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    expect(await screen.findByText('Обязательное поле')).toBeInTheDocument();
    expect(body).toBeNull();
    await userEvent.type(
      screen.getByLabelText('Акт расхождения AT-2026-000123'),
      'Недостача 400 кг, акт № 17',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({
      items: [{ batchId: BATCH_ID, massActualKg: '12080.000', discrepancyAct: 'Недостача 400 кг, акт № 17' }],
    });
    expect(ifMatch).toBe('2');
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    await waitFor(() => expect(toastText('polite')).toContain('Накладная WB-2026-000017 принята'));
  });

  it('VERSION_CONFLICT on accept: the card is read again and the person is told to repeat', async () => {
    let reads = 0;
    server.use(
      asProcessor(),
      contractResponse('getWaybill', { onRequest: () => void reads++ }),
      contractResponse('acceptWaybill', { status: 409, example: 'versionConflict' }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await screen.findByLabelText('Фактическая масса AT-2026-000123');
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(toastText()).toContain('Накладная изменилась'));
    await waitFor(() => expect(reads).toBe(2));
  });

  it('sender: «Отправить» with If-Match; BR-01 is shown as the rule with its date', async () => {
    let ifMatch: string | null = null;
    server.use(
      contractResponse('getWaybill', { body: draft() }),
      contractResponse('sendWaybill', {
        status: 422,
        example: 'waitingPeriod',
        onRequest: (r) => void (ifMatch = r.headers.get('If-Match')),
      }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    expect(screen.queryByLabelText('Фактическая масса AT-2026-000123')).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Отправить' }));
    await waitFor(() =>
      expect(toastText()).toContain(
        'Партию AT-2026-000123 можно отгрузить с 25.09.2026: не истёк срок ожидания препарата Хлорпирифос',
      ),
    );
    expect(ifMatch).toBe('1');
  });

  it('sender: a sent draft updates the card and the batches', async () => {
    server.use(
      contractResponse('getWaybill', { body: draft() }),
      contractResponse('sendWaybill', { body: sentWaybill({ actions: [] }) }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(toastText('polite')).toContain('Накладная WB-2026-000017 отправлена'));
    expect(screen.getAllByText('Отправлена')[0]).toHaveAttribute('data-tone', 'move');
    expect(screen.queryByRole('button', { name: 'Отправить' })).toBeNull();
  });

  it('delete a draft: confirmation dialog, DELETE with If-Match, back to the list', async () => {
    let ifMatch: string | null = null;
    server.use(
      contractResponse('getWaybill', { body: draft() }),
      contractResponse('deleteWaybill', { onRequest: (r) => void (ifMatch = r.headers.get('If-Match')) }),
    );
    const { router } = await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить черновик' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить черновик WB-2026-000017' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить черновик' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/waybills'));
    expect(ifMatch).toBe('1');
  });

  it('reject: the dialog asks for the number again; the reason goes to the server', async () => {
    let body: unknown = null;
    server.use(
      asProcessor(),
      contractResponse('rejectWaybill', {
        body: sentWaybill({ status: 'REJECTED', rejectReason: 'Влажность 17%', version: 3, actions: [] }),
        onRequest: async (r) => void (body = await r.json()),
      }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Отказаться' }));
    const dialog = await screen.findByRole('dialog', { name: 'Отказ от накладной WB-2026-000017' });
    const confirm = within(dialog).getByRole('button', { name: 'Отказаться' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Причина отказа'), 'Влажность 17%');
    await userEvent.type(
      within(dialog).getByLabelText('Номер накладной для подтверждения'),
      'WB-2026-000017',
    );
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(body).toEqual({ reason: 'Влажность 17%' }));
    expect(await screen.findByText('Влажность 17%')).toBeInTheDocument();
  });

  it('INSPECTOR sees the card without actions; 404 is a plain message', async () => {
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      contractResponse('getWaybill', { body: sentWaybill({ actions: [] }) }),
    );
    const { router } = await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await screen.findByRole('link', { name: 'AT-2026-000123' });
    expect(screen.queryByRole('button', { name: 'Отказаться' })).toBeNull();
    expect(screen.queryByLabelText('Фактическая масса AT-2026-000123')).toBeNull();
    server.use(contractResponse('getWaybill', { status: 404 }));
    router.navigate('/waybills/00000000-0000-4000-8000-000000000009');
    expect(await screen.findByText('Накладной нет или она вам недоступна.')).toBeInTheDocument();
  });
});
