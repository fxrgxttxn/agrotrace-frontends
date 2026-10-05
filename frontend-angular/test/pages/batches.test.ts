import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse } from '../msw/fromContract';
import { asMe, dictionaries, pageOf, paramsOf, pathOf, problem, searchOf, toastText } from '../msw/data';
import { renderApp, type AppHarness } from '../app/renderApp';
import { expectNoLeakedInputs } from '../ui/leaks';

const go = (h: AppHarness, url: string) => h.fixture.ngZone!.run(() => h.router.navigateByUrl(url));

const mounted: { graph: { nodes: unknown[] } }[] = [];
vi.mock('../../src/graph/cytoscape', () => ({
  mountGraph: (_el: HTMLElement, graph: { nodes: unknown[] }) => {
    mounted.push({ graph });
    return { zoom: () => {}, fit: () => {}, destroy: () => {} };
  },
}));

const BATCH_ID = '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c';
const batch = (extra: Record<string, unknown> = {}) => ({
  ...(contractExample('getBatch').body as Record<string, unknown>),
  ...extra,
});
const item = (extra: Record<string, unknown> = {}) => ({
  ...((contractExample('listBatches').body as { items: Record<string, unknown>[] }).items[0] ?? {}),
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

describe('/batches', () => {
  it('the registry: code link with product, status chip, mass, holder; FARMER may register', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      dictionaries(),
      contractResponse('listBatches', { onRequest: (r) => void (query = new URL(r.url).searchParams) }),
    );
    await open('/batches', 'Партии');
    const link = await screen.findByRole('link', { name: 'AT-2026-000123' });
    expect(link).toHaveAttribute('href', `/batches/${BATCH_ID}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText('Пшеница озимая')).toBeInTheDocument();
    expect(within(row).getByText('Допущена')).toHaveAttribute('data-status', 'Approved');
    expect(within(row).getByText('12 480,000')).toBeInTheDocument();
    expect(within(row).getByText('КФХ Петров')).toBeInTheDocument();
    expect(within(row).getByText('18.07.2026')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Зарегистрировать партию' })[0]).toHaveAttribute(
      'href',
      '/batches/new',
    );
    expect(query!.has('sort')).toBe(false);
    expect(query!.has('orgId')).toBe(false);
    expectNoLeakedInputs(document.body);
  });

  it('filters go to the URL and the server (status, holder, origin); pagination keeps them', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      dictionaries(),
      contractResponse('listBatches', {
        body: pageOf([item()], 45),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    const h = await open('/batches', 'Партии');
    await screen.findByRole('link', { name: 'AT-2026-000123' });
    await openFilters();
    await userEvent.selectOptions(screen.getByLabelText('Статус'), 'На анализе');
    await waitFor(() => expect(seen.at(-1)!.getAll('status')).toEqual(['OnTest']));
    await userEvent.selectOptions(screen.getByLabelText('Держатель'), 'У нашей организации');
    await userEvent.selectOptions(screen.getByLabelText('Создатель'), 'Созданные нами');
    await waitFor(() => expect(seen.at(-1)!.get('origin')).toBe('me'));
    expect(seen.at(-1)!.get('holder')).toBe('me');
    const url = paramsOf(h.url());
    expect(url.get('status')).toBe('OnTest');
    expect(screen.getByRole('link', { name: '2' }).getAttribute('href')).toBe(
      `/batches?${new URLSearchParams({ status: 'OnTest', holder: 'me', origin: 'me', page: '2' })}`,
    );
    expect(document.querySelector('.at-page__filters-count')?.textContent).toBe('3');
  });

  it('INSPECTOR: no holder/origin filters, organization filter → orgId; no register button', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      dictionaries(),
      contractResponse('listBatches', { onRequest: (r) => void seen.push(new URL(r.url).searchParams) }),
      contractResponse('getOrganization'),
    );
    await open('/batches?orgId=0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10&holder=me', 'Партии');
    await screen.findByRole('link', { name: 'AT-2026-000123' });
    expect(seen.at(-1)!.get('orgId')).toBe('0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10');
    expect(seen.at(-1)!.has('holder')).toBe(false);
    await openFilters();
    expect(screen.queryByLabelText('Держатель')).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Организация' })).toHaveValue('КФХ Петров'),
    );
    expect(screen.queryByRole('link', { name: 'Зарегистрировать партию' })).toBeNull();
  });

  it('empty and filtered-empty states', async () => {
    server.use(dictionaries(), contractResponse('listBatches', { body: pageOf([]) }));
    const h = await open('/batches', 'Партии');
    expect(await screen.findByText('Партий пока нет.')).toBeInTheDocument();
    await go(h, '/batches?kind=DERIVED');
    expect(await screen.findByText('Ничего не найдено.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));
    await waitFor(() => expect(searchOf(h.url())).toBe(''));
    expect(screen.getByRole('heading', { level: 1, name: 'Партии' })).toHaveFocus();
  });
});

describe('/batches/new', () => {
  async function fill() {
    await userEvent.selectOptions(await screen.findByLabelText('Поле'), 'Участок «Восточный-3»');
    await userEvent.selectOptions(screen.getByLabelText('Продукт'), 'Пшеница озимая');
    await userEvent.type(screen.getByLabelText('Масса'), '12480,5');
    await userEvent.type(screen.getByLabelText('Дата уборки'), '18.07.2026');
    fireEvent.input(screen.getByLabelText('Время уборки'), { target: { value: '06:15' } });
  }

  it('registers a raw batch and says what the risk model decided (lab test: reason)', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      dictionaries(),
      contractResponse('createBatch', { onRequest: async (r) => void (body = await r.json()) }),
    );
    const h = await open('/batches/new', 'Новая партия');
    expect(screen.queryByRole('option', { name: 'Мука пшеничная высшего сорта' })).toBeNull();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Зарегистрировать партию' }));
    await waitFor(() => expect(pathOf(h.url())).toBe(`/batches/${BATCH_ID}`));
    expect(body).toEqual({
      fieldId: '2e4a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e',
      productId: '7a2b4c6d-8e0f-4a1b-9c3d-5e7f9a1b3c5d',
      massKg: '12480.500',
      harvestedAt: new Date('2026-07-18T06:15:00').toISOString().replace('.000Z', 'Z'),
    });
    await waitFor(() =>
      expect(toastText('polite')).toContain(
        'Партия AT-2026-000123 зарегистрирована и направлена на анализ: Пестициды за последние 30 дней',
      ),
    );
  });

  it('an answer after the person left the form does not navigate; its success is still said (same session)', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    server.use(dictionaries(), contractResponse('createBatch', { onRequest: () => held }));
    const h = await open('/batches/new', 'Новая партия');
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Зарегистрировать партию' }));
    await go(h, '/batches');
    await screen.findByRole('heading', { level: 1, name: 'Партии' });
    release();
    await new Promise((r) => setTimeout(r, 150));
    expect(pathOf(h.url())).toBe('/batches');
    expect(toastText('polite')).toContain('зарегистрирована');
  });

  it('no lab test needed: the batch is approved', async () => {
    server.use(
      dictionaries(),
      contractResponse('createBatch', {
        body: batch({ status: 'Approved', testRequired: false, testReason: 'NONE' }),
      }),
    );
    await open('/batches/new', 'Новая партия');
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Зарегистрировать партию' }));
    await waitFor(() =>
      expect(toastText('polite')).toContain(
        'Партия AT-2026-000123 зарегистрирована и допущена: анализ не требуется',
      ),
    );
  });

  it('409 NO_LAB_AVAILABLE: what happened and what to do; the form stays', async () => {
    server.use(dictionaries(), contractResponse('createBatch', { status: 409 }));
    const h = await open('/batches/new', 'Новая партия');
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Зарегистрировать партию' }));
    await waitFor(() => expect(toastText()).toContain('активных лабораторий нет'));
    expect(pathOf(h.url())).toBe('/batches/new');
  });

  it('400: errors under their fields (future date, product category)', async () => {
    server.use(
      dictionaries(),
      contractResponse('createBatch', {
        status: 400,
        body: problem(400, 'VALIDATION', {
          errors: { productId: ['validation.product.category'], harvestedAt: ['validation.date.future'] },
        }),
      }),
    );
    await open('/batches/new', 'Новая партия');
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Зарегистрировать партию' }));
    expect(await screen.findByText('Недопустимая категория продукта')).toBeInTheDocument();
    expect(screen.getByText('Дата не может быть в будущем')).toBeInTheDocument();
    expect(screen.getByLabelText('Продукт')).toHaveFocus();
  });

  it('?fieldId= preselects the field; an empty form is marked without a request', async () => {
    let calls = 0;
    server.use(dictionaries(), contractResponse('createBatch', { onRequest: () => void calls++ }));
    await open('/batches/new?fieldId=2e4a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e', 'Новая партия');
    await waitFor(() =>
      expect(screen.getByLabelText('Поле')).toHaveValue('2e4a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Зарегистрировать партию' }));
    expect(await screen.findAllByText('Обязательное поле')).not.toHaveLength(0);
    expect(calls).toBe(0);
  });

  it('a farm without fields is sent to add one first', async () => {
    server.use(dictionaries(), contractResponse('listFields', { body: pageOf([]) }));
    await open('/batches/new', 'Новая партия');
    expect(await screen.findByRole('link', { name: 'Добавить поле' })).toHaveAttribute('href', '/fields/new');
  });
});

describe('/batches/:id', () => {
  it('summary card and the server’s actions as links to the screens that perform them', async () => {
    await open(`/batches/${BATCH_ID}`, 'AT-2026-000123');
    expect(screen.getByText('Допущена')).toHaveAttribute('data-size', 'l');
    expect(screen.getByText('12 480,000 кг')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Участок «Восточный-3»' })).toHaveAttribute(
      'href',
      '/fields/2e4a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e',
    );
    expect(screen.getByText('Новое хозяйство')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Отгрузить' })).toHaveAttribute(
      'href',
      `/waybills/new?batchId=${BATCH_ID}`,
    );
    expectNoLeakedInputs(document.body);
  });

  it('no actions from the server — no buttons (never recomputed on the client)', async () => {
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      contractResponse('getBatch', { body: batch({ actions: [] }) }),
    );
    await open(`/batches/${BATCH_ID}`, 'AT-2026-000123');
    expect(screen.queryByRole('link', { name: 'Отгрузить' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Участок «Восточный-3»' })).toBeInTheDocument();
  });

  it('history tab (default): statuses with reason and author, oldest first, the last is current', async () => {
    await open(`/batches/${BATCH_ID}`, 'AT-2026-000123');
    await waitFor(() => expect(document.querySelectorAll('.at-timeline__item')).toHaveLength(4));
    const items = [...document.querySelectorAll('.at-timeline__item')];
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Создана');
    expect(items[0]).toHaveTextContent('Партия зарегистрирована, Петров Иван Сергеевич');
    expect(items[1]).toHaveTextContent('Направлена на анализ, Автоматически');
    expect(items[3]).toHaveAttribute('data-current');
    expect(items[3]).toHaveAttribute('data-tone', 'move');
  });

  it('?tab=path: owners in order with the waybill; tabs change ?tab=', async () => {
    const h = await open(`/batches/${BATCH_ID}?tab=path`, 'AT-2026-000123');
    expect(screen.getByRole('tab', { name: 'Путь' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('ООО «Кубанский мукомол»')).toBeInTheDocument();
    expect(screen.getByText(/по накладной WB-2026-000017/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Анализы' }));
    expect(searchOf(h.url())).toBe('?tab=tests');
  });

  it('graph tab: related batches listed (no link without access), graph full screen below 768 px, Esc closes', async () => {
    mounted.length = 0;
    await open(`/batches/${BATCH_ID}?tab=graph`, 'AT-2026-000123');
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Эта партия')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('AT-2026-000457')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('link', { name: 'AT-2026-000457' })).toHaveAttribute(
      'href',
      '/p/AT-2026-000457',
    );
    expect(within(rows[1]!).getByText(/нет доступа/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Производная, уровень 1')).toBeInTheDocument();
    const openGraph = screen.getByRole('button', { name: 'Открыть граф' });
    await userEvent.click(openGraph);
    const canvas = await screen.findByRole('img', {
      name: 'Граф партии AT-2026-000123: источников 0, производных 1',
    });
    expect(canvas.closest('.at-graph')).toHaveAttribute('data-fullscreen');
    await waitFor(() => expect(mounted).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Закрыть граф' })).toHaveFocus();
    expect(
      within(screen.getByRole('list', { name: 'Обозначения' })).getByText('Переработана'),
    ).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Открыть граф' })).toHaveFocus());
  });

  it('tests tab asks for the batch’s lab tests', async () => {
    let batchId: string | null = null;
    const example = {
      id: '8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e',
      batch: item({ status: 'OnTest' }),
      lab: {
        id: '5a7c9e1b-3d5f-4a7c-9e1b-3d5f7a9c1e3b',
        name: 'ИЛ «Кубаньтест»',
        type: 'LAB',
        logoUrl: null,
      },
      reason: 'RISK',
      status: 'DONE',
      conclusion: 'FAIL',
      dueAt: '2026-07-24T06:05:00Z',
      overdue: false,
      createdAt: '2026-07-17T06:05:00Z',
      sampledAt: '2026-07-20T09:30:00Z',
      completedAt: '2026-07-21T09:30:00Z',
      hasProtocol: true,
    };
    server.use(
      contractResponse('listLabTests', {
        body: pageOf([example]),
        onRequest: (r) => void (batchId = new URL(r.url).searchParams.get('batchId')),
      }),
    );
    await open(`/batches/${BATCH_ID}?tab=tests`, 'AT-2026-000123');
    expect(await screen.findByText('ИЛ «Кубаньтест»')).toBeInTheDocument();
    expect(batchId).toBe(BATCH_ID);
    expect(screen.getByText('Превышение нормативов')).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByText('Риск-модель')).toBeInTheDocument();
  });

  it('docs tab: protocols and QR downloads (holder example)', async () => {
    await open(`/batches/${BATCH_ID}?tab=docs`, 'AT-2026-000123');
    expect(await screen.findByRole('link', { name: /protocol-AT-2026-000123\.pdf/ })).toHaveAttribute(
      'download',
      'protocol-AT-2026-000123.pdf',
    );
    expect(screen.getByRole('link', { name: 'Скачать PNG' })).toHaveAttribute(
      'download',
      'AT-2026-000123.png',
    );
    expect(screen.getByRole('link', { name: 'Скачать этикетку PDF' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'http://react-express.localhost/p/AT-2026-000123' }),
    ).toBeInTheDocument();
  });

  it('VSD NOT_FOUND: the holder retries the import with an Idempotency-Key; the card shows PENDING', async () => {
    const docs = contractExample('getBatchDocuments', 200, 'holder').body as Record<string, unknown>;
    let key: string | null = null;
    server.use(
      contractResponse('getBatchDocuments', {
        body: {
          ...docs,
          vsd: {
            id: '4e6a8c0e-2a4c-4e6a-8c0e-2a4c6e8a0c2e',
            importStatus: 'NOT_FOUND',
            document: null,
            attempts: 1,
            requestedAt: '2026-07-19T07:30:00Z',
            updatedAt: '2026-07-19T07:30:03Z',
          },
        },
      }),
      contractResponse('retryBatchVsdImport', {
        onRequest: (r) => void (key = r.headers.get('Idempotency-Key')),
      }),
    );
    await open(`/batches/${BATCH_ID}?tab=docs`, 'AT-2026-000123');
    expect(await screen.findByText('Не найден в Меркурии')).toHaveAttribute('data-tone', 'attention');
    await userEvent.click(screen.getByRole('button', { name: 'Повторить импорт' }));
    expect(await screen.findByText('Запрашивается в Меркурии')).toBeInTheDocument();
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(toastText('polite')).toContain('Импорт ВСД запрошен повторно');
  });

  it('VSD retry is not offered to a non-holder', async () => {
    const docs = contractExample('getBatchDocuments', 200, 'holder').body as Record<string, unknown>;
    server.use(
      contractResponse('getBatch', {
        body: batch({
          holder: {
            id: '4b6d8f0a-2c4e-4a6b-8d0f-1a3c5e7a9b1d',
            name: 'ООО «Кубанский мукомол»',
            type: 'PROCESSOR',
            logoUrl: null,
          },
        }),
      }),
      contractResponse('getBatchDocuments', {
        body: {
          ...docs,
          vsd: {
            id: '4e6a8c0e-2a4c-4e6a-8c0e-2a4c6e8a0c2e',
            importStatus: 'FAILED',
            document: null,
            attempts: 5,
            requestedAt: '2026-07-19T07:30:00Z',
            updatedAt: '2026-07-19T07:30:03Z',
          },
        },
      }),
    );
    await open(`/batches/${BATCH_ID}?tab=docs`, 'AT-2026-000123');
    expect(await screen.findByText('Меркурий недоступен')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторить импорт' })).toBeNull();
  });

  it('404: not there or not visible — back to the list', async () => {
    server.use(contractResponse('getBatch', { status: 404 }));
    await open(`/batches/${BATCH_ID}`, 'Партия');
    expect(await screen.findByText('Партии нет или она вам недоступна.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'К списку партий' })).toHaveAttribute('href', '/batches');
  });
});

describe('regressions', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const notFoundVsd = {
    id: '4e6a8c0e-2a4c-4e6a-8c0e-2a4c6e8a0c2e',
    importStatus: 'NOT_FOUND',
    document: null,
    attempts: 1,
    requestedAt: '2026-07-19T07:30:00Z',
    updatedAt: '2026-07-19T07:30:03Z',
  };
  const docsWith = (vsd: unknown) => ({
    ...(contractExample('getBatchDocuments', 200, 'holder').body as Record<string, unknown>),
    vsd,
  });

  it('?fieldId= of a field that is not the first: the field shown is the field sent', async () => {
    const f = contractExample('getField').body as Record<string, unknown>;
    let body: Record<string, unknown> | null = null;
    server.use(
      dictionaries(),
      contractResponse('listFields', {
        body: pageOf([
          { ...f, id: A, name: 'Альфа' },
          { ...f, id: B, name: 'Бета' },
        ]),
      }),
      contractResponse('createBatch', { onRequest: async (r) => void (body = await r.json()) }),
    );
    await open(`/batches/new?fieldId=${B}`, 'Новая партия');
    const select = (await screen.findByLabelText('Поле')) as HTMLSelectElement;
    expect(select.value).toBe(B);
    expect(select.selectedOptions[0]!.textContent).toBe('Бета');
    await userEvent.selectOptions(screen.getByLabelText('Продукт'), 'Пшеница озимая');
    await userEvent.type(screen.getByLabelText('Масса'), '10');
    await userEvent.type(screen.getByLabelText('Дата уборки'), '18.07.2026');
    await userEvent.click(screen.getByRole('button', { name: 'Зарегистрировать партию' }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body!['fieldId']).toBe(B);
  });

  it('invalid URL parameters are dropped (sort, enums, dates, ids, page) and never sent', async () => {
    let q: URLSearchParams | null = null;
    server.use(
      dictionaries(),
      contractResponse('listBatches', { onRequest: (r) => void (q = new URL(r.url).searchParams) }),
    );
    const h = await open(
      '/batches?sort=foo,asc&kind=BAD&holder=zzz&status=Nope&status=OnTest&from=2026-13-45&productId=1&page=-3',
      'Партии',
    );
    await screen.findByRole('link', { name: 'AT-2026-000123' });
    expect([...q!.keys()].sort()).toEqual(['page', 'size', 'status']);
    expect(q!.getAll('status')).toEqual(['OnTest']);
    await waitFor(() => expect(searchOf(h.url())).toBe('?status=OnTest'));
  });

  it('several statuses from a link: the select says «Несколько (2)»; the production date sorts', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      dictionaries(),
      contractResponse('listBatches', { onRequest: (r) => void seen.push(new URL(r.url).searchParams) }),
    );
    await open('/batches?status=OnTest&status=Approved', 'Партии');
    await screen.findByRole('link', { name: 'AT-2026-000123' });
    await openFilters();
    const select = screen.getByLabelText('Статус') as HTMLSelectElement;
    expect(select.selectedOptions[0]!.textContent).toBe('Несколько (2)');
    expect(screen.queryByRole('button', { name: 'Дата производства' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Вид'), 'Сырьевая');
    await userEvent.click(await screen.findByRole('button', { name: 'Дата производства' }));
    await waitFor(() => expect(seen.at(-1)!.get('sort')).toBe('harvestedAt,asc'));
  });

  it('an empty slice inside the list (the list changed meanwhile): a reload, never an endless loading', async () => {
    server.use(dictionaries(), contractResponse('listBatches', { body: pageOf([], 30), once: true }));
    await open('/batches', 'Партии');
    await userEvent.click(await screen.findByRole('button', { name: 'Обновить список' }));
    expect(await screen.findByRole('link', { name: 'AT-2026-000123' })).toBeInTheDocument();
  });

  it('a date filter that came back with the URL (back/forward) survives a blur', async () => {
    server.use(dictionaries());
    const h = await open('/batches', 'Партии');
    await screen.findByRole('link', { name: 'AT-2026-000123' });
    await go(h, '/batches?from=2026-07-01');
    await openFilters();
    const from = screen.getByLabelText('Произведена с');
    await waitFor(() => expect(from).toHaveValue('01.07.2026'));
    await userEvent.click(from);
    await userEvent.tab();
    expect(paramsOf(h.url()).get('from')).toBe('2026-07-01');
  });

  it('a list 400 offers «Сбросить фильтры»', async () => {
    server.use(
      dictionaries(),
      contractResponse('listBatches', {
        status: 400,
        body: problem(400, 'VALIDATION', { errors: { q: ['validation.maxLength'] } }),
        once: true,
      }),
    );
    const h = await open('/batches?q=x', 'Партии');
    await userEvent.click(await screen.findByRole('button', { name: 'Сбросить фильтры' }));
    await waitFor(() => expect(searchOf(h.url())).toBe(''));
  });

  it('VSD PENDING: the card asks again until the import is done', async () => {
    server.use(
      contractResponse('getBatchDocuments', {
        body: docsWith({ ...notFoundVsd, importStatus: 'PENDING' }),
        once: true,
      }),
      contractResponse('getBatchDocuments'),
    );
    await open(`/batches/${BATCH_ID}?tab=docs`, 'AT-2026-000123');
    expect(await screen.findByText('Запрашивается в Меркурии')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Запрашивается в Меркурии')).toBeNull(), { timeout: 6000 });
  });

  it('VSD retry: a network failure keeps the Idempotency-Key; a 429 counts down on the button', async () => {
    const keys: (string | null)[] = [];
    server.use(
      contractResponse('getBatchDocuments', { body: docsWith(notFoundVsd) }),
      http.post(
        `${API_BASE}/batches/:id/documents/vsd/retry`,
        ({ request }) => {
          keys.push(request.headers.get('Idempotency-Key'));
          return HttpResponse.error();
        },
        { once: true },
      ),
      contractResponse('retryBatchVsdImport', {
        status: 429,
        headers: { 'Retry-After': '2' },
        once: true,
        onRequest: (r) => void keys.push(r.headers.get('Idempotency-Key')),
      }),
    );
    await open(`/batches/${BATCH_ID}?tab=docs`, 'AT-2026-000123');
    await userEvent.click(await screen.findByRole('button', { name: 'Повторить импорт' }));
    await waitFor(() => expect(keys).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Повторить импорт' })).not.toHaveAttribute('aria-busy'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Повторить импорт' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    expect(await screen.findByRole('button', { name: /^Повторить через [12] с$/ })).toBeDisabled();
  });

  it('graph full screen makes the rest inert; the table shows the mass of each link and public links', async () => {
    await open(`/batches/${BATCH_ID}?tab=graph`, 'AT-2026-000123');
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(within(rows[1]!).getByText('10 000,000')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('link', { name: 'AT-2026-000457' })).toHaveAttribute(
      'href',
      '/p/AT-2026-000457',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Открыть граф' }));
    const block = (await screen.findByRole('img', { name: /^Граф партии/ })).closest('.at-graph')!;
    const heading = document.querySelector('h1.at-page__title')!;
    expect(heading.closest('[inert]')).not.toBeNull();
    expect(block.closest('[inert]')).toBeNull();
    expect(document.querySelector('.at-toasts')!.closest('[inert]')).toBeNull();
    expect(document.getElementById('panel-graph')).toHaveAttribute('tabindex', '-1');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('[inert]')).toBeNull());
    expect(document.getElementById('panel-graph')).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'Открыть граф' })).toHaveFocus();
  });
});
