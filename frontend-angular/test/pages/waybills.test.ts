import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { asMe, pageOf, pathOf, problem, searchOf, toastText } from '../msw/data';
import { renderApp, type AppHarness } from '../app/renderApp';

const go = (h: AppHarness, url: string) => h.fixture.ngZone!.run(() => h.router.navigateByUrl(url));
import { discrepancyText } from '../../src/pages/waybills';

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
    const h = await open('/waybills?direction=incoming', 'Накладные');
    await screen.findByRole('link', { name: 'WB-2026-000017' });
    expect(seen.at(-1)!.get('direction')).toBe('incoming');
    await openFilters();
    expect(screen.getByLabelText('Направление')).toHaveValue('incoming');
    await userEvent.selectOptions(screen.getByLabelText('Статус'), 'Отправлена');
    await waitFor(() => expect(seen.at(-1)!.getAll('status')).toEqual(['SENT']));
    expect(new URLSearchParams(searchOf(h.url())).get('direction')).toBe('incoming');
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
    const h = await open('/waybills', 'Накладные');
    expect(await screen.findByText('Накладных пока нет.')).toBeInTheDocument();
    void go(h, '/waybills?status=SENT');
    expect(await screen.findByText('Ничего не найдено.')).toBeInTheDocument();
  });
});

describe('/waybills/new', () => {
  async function pickReceiver() {
    await userEvent.type(await screen.findByRole('combobox', { name: 'Получатель' }), 'Куб');
    const list = await screen.findByRole('listbox', { name: 'Получатель' });
    await userEvent.click((await within(list).findAllByRole('option'))[0]!);
  }

  it('a picked receiver is not read back by id (FARMER: another organization answers 404)', async () => {
    let reads = 0;
    server.use(
      http.get(`${API_BASE}/organizations/:id`, () => {
        reads++;
        return HttpResponse.json(problem(404, 'NOT_FOUND'), { status: 404 });
      }),
    );
    await open('/waybills/new', 'Новая накладная');
    await pickReceiver();
    expect(screen.getByRole('combobox', { name: 'Получатель' })).toHaveValue('ООО «Кубанский мукомол»');
    await new Promise((r) => setTimeout(r, 100));
    expect(reads).toBe(0);
  });

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
    const h = await open(`/waybills/new?batchId=${BATCH_ID}`, 'Новая накладная');
    expect(stockQuery!.get('holder')).toBe('me');
    expect(stockQuery!.getAll('status').sort()).toEqual(['Accepted', 'Approved']);
    expect(await screen.findByRole('checkbox', { name: 'Выбрать AT-2026-000123' })).toBeChecked();
    expect(screen.getByLabelText('Заявленная масса AT-2026-000123')).toHaveValue('12480,000');
    await pickReceiver();
    await userEvent.click(screen.getByRole('button', { name: 'Создать накладную' }));
    await waitFor(() => expect(pathOf(h.url())).toBe(`/waybills/${WAYBILL_ID}`));
    expect(body).toEqual({
      receiverOrgId: MUKOMOL.id,
      items: [{ batchId: BATCH_ID, massDeclaredKg: '12480.000' }],
    });
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    await waitFor(() => expect(toastText('polite')).toContain('Черновик WB-2026-000017 создан'));
  });

  it('an empty form is marked without a request; a mass above the batch is caught before sending', async () => {
    let calls = 0;
    server.use(contractResponse('createWaybill', { onRequest: () => void calls++ }));
    await open('/waybills/new', 'Новая накладная');
    await userEvent.click(await screen.findByRole('button', { name: 'Создать накладную' }));
    expect(await screen.findByText('Выберите хотя бы одну партию')).toBeInTheDocument();
    expect(screen.getByText('Обязательное поле')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Получатель' })).toHaveFocus());
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
    const h = await open(`/waybills/new?batchId=${BATCH_ID}`, 'Новая накладная');
    await screen.findByRole('checkbox', { name: 'Выбрать AT-2026-000123' });
    await pickReceiver();
    await userEvent.click(screen.getByRole('button', { name: 'Создать накладную' }));
    await waitFor(() => expect(pathOf(h.url())).toBe(`/waybills/${WAYBILL_ID}`), {
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
    await userEvent.click(await screen.findByRole('button', { name: 'Отгрузить' }));
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
    await userEvent.click(await screen.findByRole('button', { name: 'Отгрузить' }));
    await waitFor(() => expect(toastText('polite')).toContain('Накладная WB-2026-000017 отправлена'));
    expect(screen.getAllByText('Отправлена')[0]).toHaveAttribute('data-tone', 'move');
    expect(screen.queryByRole('button', { name: 'Отгрузить' })).toBeNull();
  });

  it('delete a draft: confirmation dialog, DELETE with If-Match, back to the list', async () => {
    let ifMatch: string | null = null;
    server.use(
      contractResponse('getWaybill', { body: draft() }),
      contractResponse('deleteWaybill', { onRequest: (r) => void (ifMatch = r.headers.get('If-Match')) }),
    );
    const h = await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить черновик' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить черновик WB-2026-000017' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить черновик' }));
    await waitFor(() => expect(pathOf(h.url())).toBe('/waybills'));
    expect(ifMatch).toBe('1');
  });

  it('a deleted draft is not read again (no GET answering 404 after the DELETE)', async () => {
    let reads = 0;
    let deleted = false;
    server.use(
      http.get(`${API_BASE}/waybills/:id`, () => {
        if (deleted) {
          reads++;
          return HttpResponse.json(problem(404, 'NOT_FOUND'), { status: 404 });
        }
        return HttpResponse.json(draft());
      }),
      contractResponse('deleteWaybill', { onRequest: () => void (deleted = true) }),
    );
    const h = await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить черновик' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить черновик WB-2026-000017' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить черновик' }));
    await waitFor(() => expect(pathOf(h.url())).toBe('/waybills'));
    await screen.findByRole('heading', { level: 1, name: 'Накладные' });
    await new Promise((r) => setTimeout(r, 100));
    expect(reads).toBe(0);
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
    const h = await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await screen.findByRole('link', { name: 'AT-2026-000123' });
    expect(screen.queryByRole('button', { name: 'Отказаться' })).toBeNull();
    expect(screen.queryByLabelText('Фактическая масса AT-2026-000123')).toBeNull();
    server.use(contractResponse('getWaybill', { status: 404 }));
    void go(h, '/waybills/00000000-0000-4000-8000-000000000009');
    expect(await screen.findByText('Накладной нет или она вам недоступна.')).toBeInTheDocument();
  });
});

const WB = `${API_BASE}/waybills`;
const keyOf = (r: Request) => r.headers.get('Idempotency-Key');
const unavailable = () =>
  HttpResponse.json(problem(503, 'BACKEND_UNAVAILABLE'), { status: 503, headers: { 'Retry-After': '1' } });
const alerts = () => document.querySelectorAll('.at-toast-region[role="alert"] .at-toast').length;

async function pickAnyReceiver() {
  await userEvent.type(await screen.findByRole('combobox', { name: 'Получатель' }), 'Куб');
  const list = await screen.findByRole('listbox', { name: 'Получатель' });
  await userEvent.click((await within(list).findAllByRole('option'))[0]!);
}

describe('/waybills/:id — conflicts', () => {
  it('accept VERSION_CONFLICT: re-read with a new version, typed values and the message stay, the retry uses it', async () => {
    const ifMatch: (string | null)[] = [];
    server.use(
      asProcessor(),
      contractResponse('getWaybill', { body: sentWaybill(), once: true }),
      contractResponse('getWaybill', { body: sentWaybill({ version: 3 }) }),
      contractResponse('acceptWaybill', {
        status: 409,
        example: 'versionConflict',
        once: true,
        onRequest: (r) => void ifMatch.push(r.headers.get('If-Match')),
      }),
      contractResponse('acceptWaybill', {
        body: sentWaybill({ status: 'ACCEPTED', version: 4, actions: [] }),
        onRequest: (r) => void ifMatch.push(r.headers.get('If-Match')),
      }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    const actual = await screen.findByLabelText('Фактическая масса AT-2026-000123');
    await userEvent.clear(actual);
    await userEvent.type(actual, '12080');
    await userEvent.type(screen.getByLabelText('Акт расхождения AT-2026-000123'), 'Акт № 17');
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(toastText()).toContain('Накладная изменилась'));
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByLabelText('Фактическая масса AT-2026-000123')).toHaveValue('12080');
    expect(screen.getByLabelText('Акт расхождения AT-2026-000123')).toHaveValue('Акт № 17');
    expect(toastText()).toContain('Накладная изменилась');
    expect(document.activeElement).not.toBe(document.body);
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(ifMatch).toEqual(['2', '3']));
  });

  it('the refocus after a re-read never takes the focus from a field the person moved to', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    server.use(
      asProcessor(),
      contractResponse('getWaybill', { body: sentWaybill(), once: true }),
      contractResponse('getWaybill', { body: sentWaybill({ version: 3 }), onRequest: () => held }),
      contractResponse('acceptWaybill', { status: 409, example: 'versionConflict' }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    const actual = await screen.findByLabelText('Фактическая масса AT-2026-000123');
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(toastText()).toContain('Накладная изменилась'));
    await userEvent.click(actual);
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(actual).toHaveFocus();
  });

  it('accepted elsewhere (INVALID_TRANSITION): the form goes, the message stays, the focus is on the page title', async () => {
    server.use(
      asProcessor(),
      contractResponse('getWaybill', { body: sentWaybill(), once: true }),
      contractResponse('getWaybill', {
        body: sentWaybill({
          status: 'ACCEPTED',
          version: 3,
          actions: [],
          acceptedAt: '2026-08-02T09:30:00Z',
        }),
      }),
      contractResponse('acceptWaybill', { status: 409, example: 'waybillTransition' }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await screen.findByLabelText('Фактическая масса AT-2026-000123');
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(screen.queryByLabelText('Фактическая масса AT-2026-000123')).toBeNull());
    expect(toastText()).toContain('Накладная уже в статусе «Принята»');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'WB-2026-000017' })).toHaveFocus(),
    );
  });

  it('422 BR-06 on accept: the rule text and the card read again', async () => {
    let reads = 0;
    server.use(
      asProcessor(),
      contractResponse('getWaybill', { onRequest: () => void reads++ }),
      contractResponse('acceptWaybill', { status: 422, example: 'recalled' }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await screen.findByLabelText('Фактическая масса AT-2026-000123');
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(toastText()).toContain('Партия AT-2026-000123 в статусе «Отозвана»'));
    await waitFor(() => expect(reads).toBe(2));
  });

  it('send: VERSION_CONFLICT re-reads; INVALID_TRANSITION says the state; messages replace each other', async () => {
    let reads = 0;
    server.use(
      contractResponse('getWaybill', { body: draft(), onRequest: () => void reads++ }),
      contractResponse('sendWaybill', { status: 409, example: 'versionConflict', once: true }),
      contractResponse('sendWaybill', { status: 409, example: 'waybillTransition' }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Отгрузить' }));
    await waitFor(() => expect(toastText()).toContain('Накладная изменилась'));
    await waitFor(() => expect(reads).toBe(2));
    await userEvent.click(await screen.findByRole('button', { name: 'Отгрузить' }));
    await waitFor(() => expect(toastText()).toContain('Накладная уже в статусе «Отправлена»'));
    expect(alerts()).toBe(1);
  });

  it('delete VERSION_CONFLICT: the message in the dialog, the card read again', async () => {
    let reads = 0;
    server.use(
      contractResponse('getWaybill', { body: draft(), onRequest: () => void reads++ }),
      contractResponse('deleteWaybill', { status: 409, example: 'versionConflict' }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить черновик' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить черновик WB-2026-000017' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить черновик' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Накладная изменилась');
    await waitFor(() => expect(reads).toBe(2));
  });

  it('an identical re-read, then a send that removes «Отгрузить»: the focus is on the title, never the body', async () => {
    let reads = 0;
    server.use(
      contractResponse('getWaybill', { body: draft(), onRequest: () => void reads++ }),
      contractResponse('deleteWaybill', { status: 409, example: 'versionConflict' }),
      contractResponse('sendWaybill', { body: draft({ status: 'SENT', version: 2, actions: [] }) }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить черновик' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить черновик WB-2026-000017' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить черновик' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Накладная изменилась');
    await waitFor(() => expect(reads).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await userEvent.click(screen.getByRole('button', { name: 'Отгрузить' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Отгрузить' })).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'WB-2026-000017' })).toHaveFocus(),
    );
  });

  it('reject VERSION_CONFLICT keeps the reason and the number; the confirmation then uses the new version', async () => {
    const ifMatch: (string | null)[] = [];
    server.use(
      asProcessor(),
      contractResponse('getWaybill', { body: sentWaybill(), once: true }),
      contractResponse('getWaybill', { body: sentWaybill({ version: 3 }) }),
      contractResponse('rejectWaybill', {
        status: 409,
        example: 'versionConflict',
        once: true,
        onRequest: (r) => void ifMatch.push(r.headers.get('If-Match')),
      }),
      contractResponse('rejectWaybill', {
        body: sentWaybill({ status: 'REJECTED', rejectReason: 'Влажность 17%', version: 4, actions: [] }),
        onRequest: (r) => void ifMatch.push(r.headers.get('If-Match')),
      }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Отказаться' }));
    const dialog = await screen.findByRole('dialog', { name: 'Отказ от накладной WB-2026-000017' });
    await userEvent.type(within(dialog).getByLabelText('Причина отказа'), 'Влажность 17%');
    await userEvent.type(
      within(dialog).getByLabelText('Номер накладной для подтверждения'),
      'WB-2026-000017',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отказаться' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Накладная изменилась');
    expect(within(dialog).getByLabelText('Причина отказа')).toHaveValue('Влажность 17%');
    await new Promise((r) => setTimeout(r, 300));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отказаться' }));
    await waitFor(() => expect(ifMatch).toEqual(['2', '3']));
  });

  it('reject: after a failure and «Отмена» the reopened dialog is empty and asks for the number again', async () => {
    server.use(asProcessor(), contractResponse('rejectWaybill', { status: 409, example: 'versionConflict' }));
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Отказаться' }));
    let dialog = await screen.findByRole('dialog', { name: 'Отказ от накладной WB-2026-000017' });
    await userEvent.type(within(dialog).getByLabelText('Причина отказа'), 'Причина');
    await userEvent.type(
      within(dialog).getByLabelText('Номер накладной для подтверждения'),
      'WB-2026-000017',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отказаться' }));
    await within(dialog).findByRole('alert');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Отказаться' }));
    dialog = await screen.findByRole('dialog', { name: 'Отказ от накладной WB-2026-000017' });
    expect(within(dialog).getByLabelText('Причина отказа')).toHaveValue('');
    expect(within(dialog).getByLabelText('Номер накладной для подтверждения')).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: 'Отказаться' })).toBeDisabled();
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('delete 429: the wait on the confirmation button, the reason in the dialog', async () => {
    server.use(
      contractResponse('getWaybill', { body: draft() }),
      contractResponse('deleteWaybill', { status: 429, headers: { 'Retry-After': '2' } }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить черновик' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить черновик WB-2026-000017' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить черновик' }));
    expect(await within(dialog).findByRole('button', { name: /^Повторить через [12] с$/ })).toBeDisabled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('повторите через 2 с');
  });

  it('a 429 wait on «Отгрузить»: the button gets the focus back when it can act again', async () => {
    server.use(
      contractResponse('getWaybill', { body: draft() }),
      contractResponse('sendWaybill', { status: 429, headers: { 'Retry-After': '1' } }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Отгрузить' }));
    expect(await screen.findByRole('button', { name: /^Повторить через 1 с$/ })).toBeDisabled();
    const button = await screen.findByRole('button', { name: 'Отгрузить' }, { timeout: 3000 });
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('the end of the wait never takes the focus from a control the person moved to', async () => {
    server.use(
      contractResponse('getWaybill', { body: draft() }),
      contractResponse('sendWaybill', { status: 429, headers: { 'Retry-After': '1' } }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Отгрузить' }));
    expect(await screen.findByRole('button', { name: /^Повторить через 1 с$/ })).toBeDisabled();
    const other = screen.getByRole('button', { name: 'Удалить черновик' });
    other.focus();
    await screen.findByRole('button', { name: 'Отгрузить' }, { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(other).toHaveFocus();
  });

  it('reject 429: the wait is on the confirmation button and said in the dialog', async () => {
    server.use(
      asProcessor(),
      contractResponse('rejectWaybill', { status: 429, headers: { 'Retry-After': '2' } }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Отказаться' }));
    const dialog = await screen.findByRole('dialog', { name: 'Отказ от накладной WB-2026-000017' });
    await userEvent.type(within(dialog).getByLabelText('Причина отказа'), 'Причина');
    await userEvent.type(
      within(dialog).getByLabelText('Номер накладной для подтверждения'),
      'WB-2026-000017',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отказаться' }));
    expect(await within(dialog).findByRole('button', { name: /^Повторить через [12] с$/ })).toBeDisabled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('повторите через 2 с');
  });

  it('the BR-07 text never contradicts the threshold: rounded to 2,00% but over the limit reads «больше 2%»', () => {
    expect(discrepancyText({ percent: '2.00', actRequired: true })).toBe('больше 2%');
    expect(discrepancyText({ percent: '2.00', actRequired: false })).toBe('2,00%');
    expect(discrepancyText({ percent: '3.21', actRequired: true })).toBe('3,21%');
  });
});

describe('Idempotency-Key per request (BR-11)', () => {
  async function createForm() {
    await open(`/waybills/new?batchId=${BATCH_ID}`, 'Новая накладная');
    await screen.findByRole('checkbox', { name: 'Выбрать AT-2026-000123' });
    await pickAnyReceiver();
  }
  const submitCreate = () => userEvent.click(screen.getByRole('button', { name: 'Создать накладную' }));

  it('create: the same key after a network failure and after a 5xx', async () => {
    const keys: (string | null)[] = [];
    server.use(
      http.post(WB, ({ request }) => (keys.push(keyOf(request)), HttpResponse.error()), { once: true }),
      http.post(WB, ({ request }) => (keys.push(keyOf(request)), unavailable()), { once: true }),
      contractResponse('createWaybill', { onRequest: (r) => void keys.push(keyOf(r)) }),
    );
    await createForm();
    await submitCreate();
    await waitFor(() => expect(keys).toHaveLength(1));
    await submitCreate();
    await waitFor(() => expect(keys).toHaveLength(2));
    await submitCreate();
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(new Set(keys).size).toBe(1);
  });

  it('create: an edit after the failure is a new request with a new key; KEY_REUSED asks to send again', async () => {
    const keys: (string | null)[] = [];
    server.use(
      http.post(WB, ({ request }) => (keys.push(keyOf(request)), HttpResponse.error()), { once: true }),
      contractResponse('createWaybill', {
        status: 409,
        example: 'idempotencyKeyReused',
        once: true,
        onRequest: (r) => void keys.push(keyOf(r)),
      }),
      contractResponse('createWaybill', { onRequest: (r) => void keys.push(keyOf(r)) }),
    );
    await createForm();
    await submitCreate();
    await waitFor(() => expect(keys).toHaveLength(1));
    const mass = screen.getByLabelText('Заявленная масса AT-2026-000123');
    await userEvent.clear(mass);
    await userEvent.type(mass, '12000');
    await submitCreate();
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
    await waitFor(() =>
      expect(toastText()).toContain('Данные формы изменились после сбоя — отправьте ещё раз'),
    );
    await submitCreate();
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('send: the same key after a network failure and after a 429 (the wait on the button)', async () => {
    const keys: (string | null)[] = [];
    server.use(
      contractResponse('getWaybill', { body: draft() }),
      http.post(`${WB}/:id/send`, ({ request }) => (keys.push(keyOf(request)), HttpResponse.error()), {
        once: true,
      }),
      contractResponse('sendWaybill', {
        status: 429,
        headers: { 'Retry-After': '1' },
        once: true,
        onRequest: (r) => void keys.push(keyOf(r)),
      }),
      contractResponse('sendWaybill', {
        body: sentWaybill({ actions: [] }),
        onRequest: (r) => void keys.push(keyOf(r)),
      }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await userEvent.click(await screen.findByRole('button', { name: 'Отгрузить' }));
    await waitFor(() => expect(keys).toHaveLength(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Отгрузить' }));
    expect(await screen.findByRole('button', { name: /^Повторить через 1 с$/ })).toBeDisabled();
    await userEvent.click(await screen.findByRole('button', { name: 'Отгрузить' }, { timeout: 3000 }));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(new Set(keys).size).toBe(1);
  });

  it('accept: the same key after a 5xx', async () => {
    const keys: (string | null)[] = [];
    server.use(
      asProcessor(),
      http.post(`${WB}/:id/accept`, ({ request }) => (keys.push(keyOf(request)), unavailable()), {
        once: true,
      }),
      contractResponse('acceptWaybill', {
        body: sentWaybill({ status: 'ACCEPTED', version: 3, actions: [] }),
        onRequest: (r) => void keys.push(keyOf(r)),
      }),
    );
    await open(`/waybills/${WAYBILL_ID}`, 'WB-2026-000017');
    await screen.findByLabelText('Фактическая масса AT-2026-000123');
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(keys).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
  });
});
