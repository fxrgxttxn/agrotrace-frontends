import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { server } from '../setup';
import { contractExample, contractResponse } from '../msw/fromContract';
import { asMe, dictionaries, pageOf, pathOf, problem, toastText } from '../msw/data';
import { renderApp, type AppHarness } from '../app/renderApp';

const go = (h: AppHarness, url: string) => h.fixture.ngZone!.run(() => h.router.navigateByUrl(url));

const BATCH_ID = '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c';
const MUKOMOL = {
  id: '4b6d8f0a-2c4e-4a6b-8d0f-1a3c5e7a9b1d',
  name: 'ООО «Кубанский мукомол»',
  type: 'PROCESSOR',
  logoUrl: null,
};
const MARKET = {
  id: '6c8e0a2b-4d6f-4b8d-9f1a-3c5e7a9b1d3f',
  name: 'ООО «Кубань-Маркет»',
  type: 'RETAILER',
  logoUrl: null,
};
const asProcessor = () => asMe({ roles: ['PROCESSOR'], organization: MUKOMOL });
const asRetailer = () => asMe({ roles: ['RETAILER'], organization: MARKET });
const item = (extra: Record<string, unknown> = {}) => ({
  ...((contractExample('listBatches').body as { items: Record<string, unknown>[] }).items[0] ?? {}),
  ...extra,
});
const batch = (extra: Record<string, unknown> = {}) => ({
  ...(contractExample('getBatch').body as Record<string, unknown>),
  ...extra,
});
const QR = contractExample('createBatchQr').body as Record<string, string>;

async function open(path: string, title: string | RegExp) {
  const utils = renderApp(path);
  await screen.findByRole('heading', { level: 1, name: title });
  return utils;
}

describe('/stock', () => {
  it('RETAILER: the own stock (Accepted, OnSale); «Выставить на продажу» with If-Match of the batch', async () => {
    let query: URLSearchParams | null = null;
    let ifMatch: string | null = null;
    server.use(
      asRetailer(),
      dictionaries(),
      contractResponse('listBatches', {
        body: pageOf([item({ status: 'Accepted', holder: MARKET })]),
        onRequest: (r) => void (query = new URL(r.url).searchParams),
      }),
      contractResponse('getBatch', {
        body: batch({ status: 'Accepted', version: 5, actions: [{ action: 'putOnSale', to: 'OnSale' }] }),
      }),
      contractResponse('putBatchOnSale', {
        body: batch({ status: 'OnSale', version: 6, actions: [{ action: 'sell', to: 'Sold' }] }),
        onRequest: (r) => void (ifMatch = r.headers.get('If-Match')),
      }),
    );
    await open('/stock', 'Склад');
    const row = (await screen.findByRole('link', { name: 'AT-2026-000123' })).closest('tr')!;
    expect(query!.get('holder')).toBe('me');
    expect(query!.getAll('status').sort()).toEqual(['Accepted', 'OnSale']);
    await userEvent.click(within(row).getByRole('button', { name: 'Выставить на продажу' }));
    await waitFor(() => expect(toastText('polite')).toContain('Партия AT-2026-000123 выставлена на продажу'));
    expect(ifMatch).toBe('5');
  });

  it('the batch no longer allows it (its own actions): no request, the list is read again', async () => {
    let posted = false;
    server.use(
      asRetailer(),
      dictionaries(),
      contractResponse('listBatches', { body: pageOf([item({ status: 'Accepted', holder: MARKET })]) }),
      contractResponse('getBatch', { body: batch({ status: 'Recalled', actions: [] }) }),
      contractResponse('putBatchOnSale', { onRequest: () => void (posted = true) }),
    );
    await open('/stock', 'Склад');
    await userEvent.click(await screen.findByRole('button', { name: 'Выставить на продажу' }));
    await waitFor(() =>
      expect(toastText()).toContain('Для партии AT-2026-000123 это действие уже недоступно'),
    );
    expect(posted).toBe(false);
  });

  it('VERSION_CONFLICT: the list is read again and the person repeats', async () => {
    server.use(
      asRetailer(),
      dictionaries(),
      contractResponse('listBatches', { body: pageOf([item({ status: 'OnSale', holder: MARKET })]) }),
      contractResponse('getBatch', {
        body: batch({ status: 'OnSale', actions: [{ action: 'sell', to: 'Sold' }] }),
      }),
      contractResponse('markBatchSold', { status: 409, example: 'versionConflict' }),
    );
    await open('/stock', 'Склад');
    await userEvent.click(await screen.findByRole('button', { name: 'Отметить реализацию' }));
    await waitFor(() => expect(toastText()).toContain('Партия AT-2026-000123 изменилась'));
  });

  it('PROCESSOR: Approved and Accepted; «Переработать» and «Отгрузить» lead to their screens', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      asProcessor(),
      dictionaries(),
      contractResponse('listBatches', {
        body: pageOf([item({ status: 'Accepted', holder: MUKOMOL })]),
        onRequest: (r) => void (query = new URL(r.url).searchParams),
      }),
    );
    await open('/stock', 'Склад');
    const row = (await screen.findByRole('link', { name: 'AT-2026-000123' })).closest('tr')!;
    expect(query!.getAll('status').sort()).toEqual(['Accepted', 'Approved']);
    expect(within(row).getByRole('link', { name: 'Переработать' })).toHaveAttribute(
      'href',
      `/processing/new?batchId=${BATCH_ID}`,
    );
    expect(within(row).getByRole('link', { name: 'Отгрузить' })).toHaveAttribute(
      'href',
      `/waybills/new?batchId=${BATCH_ID}`,
    );
  });
});

describe('/processing/new', () => {
  const stock = () =>
    contractResponse('listBatches', { body: pageOf([item({ status: 'Accepted', holder: MUKOMOL })]) });

  it('one step per screen: inputs → outputs → balance (domain BR-04), then the derived batches', async () => {
    let body: unknown = null;
    server.use(
      asProcessor(),
      dictionaries(),
      stock(),
      contractResponse('processBatches', { onRequest: async (r) => void (body = await r.json()) }),
    );
    const h = await open(`/processing/new?batchId=${BATCH_ID}`, 'Переработка');
    const steps = await screen.findByRole('list', { name: 'Переработка' });
    expect(within(steps).getByText('Входы').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(await screen.findByRole('checkbox', { name: 'Выбрать AT-2026-000123' })).toBeChecked();
    const used = screen.getByLabelText('Использовать из AT-2026-000123');
    await userEvent.clear(used);
    await userEvent.type(used, '10000');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await screen.findByRole('heading', { name: 'Выходы' });
    expect(screen.queryByLabelText('Использовать из AT-2026-000123')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Продукт выхода 1'), 'Мука пшеничная высшего сорта');
    await userEvent.type(screen.getByLabelText('Масса выхода 1'), '9000');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await screen.findByRole('heading', { name: 'Проверка баланса' });
    expect(screen.getByText('10 000,000 кг')).toBeInTheDocument();
    expect(screen.getByText('9 800,000 кг')).toBeInTheDocument();
    expect(screen.getByText('9 000,000 кг')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Переработать' }));
    await waitFor(() => expect(pathOf(h.url())).toBe('/batches/3d5f7b9d-1f3a-4c5e-9b7d-1f3a5c7e9b1d'));
    expect(body).toEqual({
      inputs: [{ batchId: BATCH_ID, massUsedKg: '10000.000' }],
      outputs: [{ productId: 'a4c6e8f0-2b4d-4f6a-8c0e-4b6d8f0a2c4e', massKg: '9000.000' }],
    });
    await waitFor(() => expect(toastText('polite')).toContain('Выпущено партий: 1 — AT-2026-000457'));
  });

  it('the balance warns before sending when the output is above the allowed (BR-04 text)', async () => {
    server.use(asProcessor(), dictionaries(), stock());
    await open(`/processing/new?batchId=${BATCH_ID}`, 'Переработка');
    await screen.findByRole('checkbox', { name: 'Выбрать AT-2026-000123' });
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.selectOptions(
      await screen.findByLabelText('Продукт выхода 1'),
      'Мука пшеничная высшего сорта',
    );
    await userEvent.type(screen.getByLabelText('Масса выхода 1'), '12480');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    expect(
      await screen.findByText(
        'Выход переработки 12 480,000 кг больше допустимого 12 230,400 кг: вход 12 480,000 кг за вычетом нормы потерь',
      ),
    ).toBeInTheDocument();
  });

  it('«Далее» without an input stays on the step and says what is missing', async () => {
    server.use(asProcessor(), dictionaries(), stock());
    await open('/processing/new', 'Переработка');
    await screen.findByRole('checkbox', { name: 'Выбрать AT-2026-000123' });
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    expect(await screen.findByText('Выберите хотя бы одну партию')).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: 'Выбрать AT-2026-000123' });
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleDescription('Выберите хотя бы одну партию');
    expect(screen.queryByRole('heading', { name: 'Выходы' })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Выбрать AT-2026-000123' }));
    await waitFor(() => expect(screen.queryByText('Выберите хотя бы одну партию')).toBeNull());
    expect(screen.getByRole('checkbox', { name: 'Выбрать AT-2026-000123' })).not.toHaveAttribute(
      'aria-invalid',
    );
    await userEvent.clear(screen.getByLabelText('Использовать из AT-2026-000123'));
    expect(await screen.findByText('Обязательное поле')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Использовать из AT-2026-000123'), '100');
    await waitFor(() => expect(screen.queryByText('Обязательное поле')).toBeNull());
  });

  it('a 400 on an input brings the person back to the inputs, the error under its row; 422 BR-05 as the rule', async () => {
    server.use(
      asProcessor(),
      dictionaries(),
      stock(),
      contractResponse('processBatches', {
        status: 400,
        body: problem(400, 'VALIDATION', {
          errors: { 'inputs[0].massUsedKg': ['validation.mass.exceedsBatch'] },
        }),
        once: true,
      }),
      contractResponse('processBatches', { status: 422, example: 'notEligible' }),
    );
    await open(`/processing/new?batchId=${BATCH_ID}`, 'Переработка');
    await screen.findByRole('checkbox', { name: 'Выбрать AT-2026-000123' });
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.selectOptions(
      await screen.findByLabelText('Продукт выхода 1'),
      'Мука пшеничная высшего сорта',
    );
    await userEvent.type(screen.getByLabelText('Масса выхода 1'), '100');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Переработать' }));
    expect(await screen.findByText('Масса превышает текущую массу партии')).toBeInTheDocument();
    expect(screen.getByLabelText('Использовать из AT-2026-000123')).toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Далее' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Переработать' }));
    await waitFor(() =>
      expect(toastText()).toContain(
        'Партия AT-2026-000124 в статусе «На анализе» не может быть входом переработки',
      ),
    );
  });
});

describe('/qr', () => {
  it('RETAILER: generate a QR code; the dialog shows it with PNG and PDF', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      asRetailer(),
      contractResponse('listBatches', {
        body: pageOf([item({ status: 'Accepted', holder: MARKET })]),
        onRequest: (r) => void (query = new URL(r.url).searchParams),
      }),
    );
    await open('/qr', 'Печать QR');
    const row = (await screen.findByRole('link', { name: 'AT-2026-000123' })).closest('tr')!;
    expect(query!.getAll('status').sort()).toEqual(['Accepted', 'OnSale']);
    expect(within(row).getByText('Не сформирован')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Сформировать QR-код AT-2026-000123' }));
    const dialog = await screen.findByRole('dialog', { name: 'QR-код AT-2026-000123' });
    expect(within(dialog).getByRole('img', { name: /^QR-код партии AT-2026-000123/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /PNG/ })).toHaveAttribute('href', QR.pngUrl);
    expect(within(dialog).getByRole('link', { name: /PDF/ })).toHaveAttribute('href', QR.pdfUrl);
  });

  it('an existing QR is downloaded from the batch documents, not generated again', async () => {
    let generated = false;
    server.use(
      asRetailer(),
      contractResponse('listBatches', {
        body: pageOf([item({ status: 'OnSale', holder: MARKET, qrGeneratedAt: '2026-08-03T09:00:00Z' })]),
      }),
      contractResponse('getBatchDocuments', {
        body: { ...(contractExample('getBatchDocuments').body as Record<string, unknown>), qr: QR },
      }),
      contractResponse('createBatchQr', { onRequest: () => void (generated = true) }),
    );
    await open('/qr', 'Печать QR');
    await userEvent.click(await screen.findByRole('button', { name: 'Скачать QR-код AT-2026-000123' }));
    const dialog = await screen.findByRole('dialog', { name: 'QR-код AT-2026-000123' });
    expect(await within(dialog).findByRole('link', { name: /PNG/ })).toHaveAttribute('href', QR.pngUrl);
    expect(generated).toBe(false);
  });

  it('403 BATCH_STATUS: the reason as text', async () => {
    server.use(
      asRetailer(),
      contractResponse('listBatches', { body: pageOf([item({ status: 'Accepted', holder: MARKET })]) }),
      contractResponse('createBatchQr', { status: 403, example: 'batchStatus' }),
    );
    await open('/qr', 'Печать QR');
    await userEvent.click(await screen.findByRole('button', { name: 'Сформировать QR-код AT-2026-000123' }));
    await waitFor(() => expect(toastText()).toContain('QR-код нельзя сформировать для партии в статусе'));
  });

  it('Esc right after the links replaced the loading state gives the focus back to «Скачать» (backlog A3+A4)', async () => {
    server.use(
      asRetailer(),
      contractResponse('listBatches', {
        body: pageOf([item({ status: 'OnSale', holder: MARKET, qrGeneratedAt: '2026-08-03T09:00:00Z' })]),
      }),
      contractResponse('getBatchDocuments', {
        body: { ...(contractExample('getBatchDocuments').body as Record<string, unknown>), qr: QR },
      }),
    );
    await open('/qr', 'Печать QR');
    const opener = await screen.findByRole('button', { name: 'Скачать QR-код AT-2026-000123' });
    await userEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'QR-код AT-2026-000123' });
    await within(dialog).findByRole('link', { name: /PNG/ });
    within(dialog).getByRole('link', { name: /PNG/ }).focus();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
    await waitFor(() => expect(opener).toHaveFocus());
    await new Promise((r) => setTimeout(r, 50));
    expect(opener).toHaveFocus();
  });

  it('«Сформировать заново» failing in the dialog is said there; closed, the page says it (README «Диалог»)', async () => {
    server.use(
      asRetailer(),
      contractResponse('listBatches', {
        body: pageOf([item({ status: 'OnSale', holder: MARKET, qrGeneratedAt: '2026-08-03T09:00:00Z' })]),
      }),
      contractResponse('getBatchDocuments', { status: 404 }),
      contractResponse('createBatchQr', { status: 403, example: 'batchStatus' }),
    );
    await open('/qr', 'Печать QR');
    await userEvent.click(await screen.findByRole('button', { name: 'Скачать QR-код AT-2026-000123' }));
    const dialog = await screen.findByRole('dialog', { name: 'QR-код AT-2026-000123' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Сформировать заново' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'QR-код нельзя сформировать для партии в статусе',
    );
    expect(toastText()).toBe('');
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(toastText()).toContain('QR-код нельзя сформировать для партии в статусе'));
  });
});

describe('late answers after leaving', () => {
  for (const status of [409, 429] as const)
    it(`a ${status} of a stock action answering after the person left: no toast on the next screen`, async () => {
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      server.use(
        asRetailer(),
        dictionaries(),
        contractResponse('listBatches', { body: pageOf([item({ status: 'OnSale', holder: MARKET })]) }),
        contractResponse('getBatch', {
          body: batch({ status: 'OnSale', actions: [{ action: 'sell', to: 'Sold' }] }),
        }),
        contractResponse(
          'markBatchSold',
          status === 409
            ? { status: 409, example: 'versionConflict', onRequest: () => held }
            : { status: 429, headers: { 'Retry-After': '1' }, onRequest: () => held },
        ),
      );
      const h = await open('/stock', 'Склад');
      await userEvent.click(await screen.findByRole('button', { name: 'Отметить реализацию' }));
      await go(h, '/profile');
      await screen.findByRole('heading', { level: 1, name: 'Профиль' });
      release();
      await new Promise((r) => setTimeout(r, 200));
      expect(toastText()).toBe('');
      expect(toastText('polite')).toBe('');
    });
});

describe('app-wide focus rescue', () => {
  it('a stock action whose button goes with the re-read row hands the focus to the page title', async () => {
    server.use(
      asRetailer(),
      dictionaries(),
      contractResponse('listBatches', {
        body: pageOf([item({ status: 'Accepted', holder: MARKET })]),
        once: true,
      }),
      contractResponse('listBatches', { body: pageOf([item({ status: 'OnSale', holder: MARKET })]) }),
      contractResponse('getBatch', {
        body: batch({ status: 'Accepted', version: 5, actions: [{ action: 'putOnSale', to: 'OnSale' }] }),
      }),
      contractResponse('putBatchOnSale', {
        body: batch({ status: 'OnSale', version: 6, actions: [{ action: 'sell', to: 'Sold' }] }),
      }),
    );
    await open('/stock', 'Склад');
    await userEvent.click(await screen.findByRole('button', { name: 'Выставить на продажу' }));
    await screen.findByRole('button', { name: 'Отметить реализацию' });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Склад' })).toHaveFocus());
  });

  it('a passive refresh that removes the focused control never moves the focus', async () => {
    server.use(
      asRetailer(),
      dictionaries(),
      contractResponse('listBatches', { body: pageOf([item({ status: 'Accepted', holder: MARKET })]) }),
    );
    await open('/stock', 'Склад');
    const button = await screen.findByRole('button', { name: 'Выставить на продажу' });
    button.focus();
    await new Promise((r) => setTimeout(r, 1200));
    button.closest('tr')!.remove();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByRole('heading', { level: 1, name: 'Склад' })).not.toHaveFocus();
  });
});
