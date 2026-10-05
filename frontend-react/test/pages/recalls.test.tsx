import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../setup';
import { API_BASE, contractExample, contractResponse, type Json } from '../msw/fromContract';
import { asMe, pageOf, problem, toastText } from '../msw/data';
import { FakeEventSource, renderApp } from '../app/renderApp';
import { render } from '@testing-library/react';
import { CodeConfirmDialog } from '../../src/app/CodeConfirm';

const INSPECTION = {
  id: 'f1a2b3c4-5000-4000-8000-000000000900',
  name: 'Инспекция агропродовольственного надзора',
  type: 'AUTHORITY',
  logoUrl: null,
};
const asInspector = () => asMe({ roles: ['INSPECTOR'], organization: INSPECTION });

const H = 3600_000;
const M = 60_000;
const recall = (extra: Json = {}): Json => ({ ...(contractExample('getRecall').body as Json), ...extra });
const RECALL_ID = recall().id as string;
const task = (extra: Json = {}): Json => ({ ...(recall().tasks as Json[])[0], ...extra });
const dueSoon = () => new Date(Date.now() + 2 * H + 30 * M + 30_000).toISOString();

async function open(path: string, title: string | RegExp) {
  const utils = renderApp(path);
  await screen.findByRole('heading', { level: 1, name: title });
  return utils;
}
async function openFilters() {
  const toggle = document.querySelector<HTMLElement>('.at-page__filters-toggle');
  if (toggle && !toggle.closest('details')!.open) await userEvent.click(toggle);
}

describe('/recall-tasks', () => {
  it('opens on the tasks awaiting withdrawal: batch, recall reason, status, the time left to the deadline', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      contractResponse('listRecallTasks', {
        body: pageOf([task({ dueAt: dueSoon() })]),
        onRequest: (r) => void (query = new URL(r.url).searchParams),
      }),
    );
    await open('/recall-tasks', 'Задачи отзыва');
    const link = await screen.findByRole('link', { name: 'AT-2026-000457' });
    expect(link).toHaveAttribute('href', `/batches/${(task().batch as Json).id}`);
    expect(query!.getAll('status').sort()).toEqual(['OPEN', 'OVERDUE']);
    const row = link.closest('tr')!;
    expect(within(row).getByText('Ожидает изъятия')).toHaveAttribute('data-tone', 'attention');
    expect(within(row).getByText(/Жалобы покупателей на горечь муки/)).toBeInTheDocument();
    expect(within(row).getByText('осталось 2 ч 30 мин')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Изъято: AT-2026-000457' })).toBeInTheDocument();
  });

  it('past the deadline the task is overdue at once (now > dueAt, before the scheduler escalates it)', async () => {
    const late = new Date(Date.now() - (3 * H + M + 5_000)).toISOString();
    server.use(contractResponse('listRecallTasks', { body: pageOf([task({ dueAt: late, overdue: true })]) }));
    await open('/recall-tasks', 'Задачи отзыва');
    const row = (await screen.findByRole('link', { name: 'AT-2026-000457' })).closest('tr')!;
    expect(within(row).getByText('Просрочено')).toHaveAttribute('data-tone', 'danger');
    expect(within(row).getByText('просрочено на 3 ч 1 мин')).toBeInTheDocument();
  });

  it('«Изъято»: the dialog asks for the batch code; POST with If-Match and an Idempotency-Key; the list is read again', async () => {
    let headers: Headers | null = null;
    let reads = 0;
    let confirmed = false;
    server.use(
      http.get(`${API_BASE}/recall-tasks`, () => {
        reads++;
        return HttpResponse.json(pageOf(confirmed ? [] : [task({ dueAt: dueSoon() })]));
      }),
      contractResponse('confirmRecallTask', {
        onRequest: (r) => {
          headers = r.headers;
          confirmed = true;
        },
      }),
    );
    await open('/recall-tasks', 'Задачи отзыва');
    await userEvent.click(await screen.findByRole('button', { name: 'Изъято: AT-2026-000457' }));
    const dialog = await screen.findByRole('dialog', { name: 'Изъятие партии AT-2026-000457' });
    const confirm = within(dialog).getByRole('button', { name: 'Подтвердить изъятие' });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByLabelText('Код партии для подтверждения')).toHaveFocus();
    await userEvent.type(within(dialog).getByLabelText('Код партии для подтверждения'), 'at-2026-000457');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(toastText('polite')).toContain('Изъятие партии AT-2026-000457 подтверждено'));
    expect(headers!.get('If-Match')).toBe('1');
    expect(headers!.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(await screen.findByText('Задач изъятия нет.')).toBeInTheDocument();
  });

  it('a network failure keeps the key: the repeat is the same request (BR-11)', async () => {
    const keys: string[] = [];
    let first = true;
    server.use(
      contractResponse('listRecallTasks', { body: pageOf([task({ dueAt: dueSoon() })]) }),
      http.post(`${API_BASE}/recall-tasks/:id/confirm`, ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key')!);
        if (first) {
          first = false;
          return HttpResponse.error();
        }
        return HttpResponse.json(contractExample('confirmRecallTask').body as Json);
      }),
    );
    await open('/recall-tasks', 'Задачи отзыва');
    await userEvent.click(await screen.findByRole('button', { name: 'Изъято: AT-2026-000457' }));
    const dialog = await screen.findByRole('dialog', { name: 'Изъятие партии AT-2026-000457' });
    await userEvent.type(within(dialog).getByLabelText('Код партии для подтверждения'), 'AT-2026-000457');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Подтвердить изъятие' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Подтвердить изъятие' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
  });

  it('VERSION_CONFLICT: said in the dialog, the list is read again and the repeat sends the new version', async () => {
    const ifMatch: (string | null)[] = [];
    let conflicted = false;
    server.use(
      http.get(`${API_BASE}/recall-tasks`, () =>
        HttpResponse.json(pageOf([task({ dueAt: dueSoon(), version: conflicted ? 2 : 1 })])),
      ),
      http.post(`${API_BASE}/recall-tasks/:id/confirm`, ({ request }) => {
        ifMatch.push(request.headers.get('If-Match'));
        if (!conflicted) {
          conflicted = true;
          return HttpResponse.json(problem(409, 'VERSION_CONFLICT', { params: { currentVersion: 2 } }), {
            status: 409,
          });
        }
        return HttpResponse.json(contractExample('confirmRecallTask').body as Json);
      }),
    );
    await open('/recall-tasks', 'Задачи отзыва');
    await userEvent.click(await screen.findByRole('button', { name: 'Изъято: AT-2026-000457' }));
    const dialog = await screen.findByRole('dialog', { name: 'Изъятие партии AT-2026-000457' });
    await userEvent.type(within(dialog).getByLabelText('Код партии для подтверждения'), 'AT-2026-000457');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Подтвердить изъятие' }));
    expect(await within(dialog).findByText(/Задача изменилась: список обновлён/)).toBeInTheDocument();
    expect(toastText()).toBe('');
    expect(within(dialog).getByLabelText('Код партии для подтверждения')).toHaveValue('AT-2026-000457');
    await waitFor(async () => {
      await userEvent.click(within(dialog).getByRole('button', { name: 'Подтвердить изъятие' }));
      expect(ifMatch).toEqual(['1', '2']);
    });
  });

  it('INVALID_TRANSITION (confirmed meanwhile) and 404 (the task went to another holder): said, the dialog closes', async () => {
    let answer: 'transition' | 'gone' = 'transition';
    server.use(
      contractResponse('listRecallTasks', { body: pageOf([task({ dueAt: dueSoon() })]) }),
      http.post(`${API_BASE}/recall-tasks/:id/confirm`, () =>
        answer === 'transition'
          ? HttpResponse.json(
              problem(409, 'INVALID_TRANSITION', { params: { from: 'CONFIRMED', to: 'CONFIRMED' } }),
              { status: 409 },
            )
          : HttpResponse.json(problem(404, 'NOT_FOUND'), { status: 404 }),
      ),
    );
    await open('/recall-tasks', 'Задачи отзыва');
    const confirmOnce = async () => {
      await userEvent.click(await screen.findByRole('button', { name: 'Изъято: AT-2026-000457' }));
      const dialog = await screen.findByRole('dialog', { name: 'Изъятие партии AT-2026-000457' });
      await userEvent.type(within(dialog).getByLabelText('Код партии для подтверждения'), 'AT-2026-000457');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Подтвердить изъятие' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };
    await confirmOnce();
    expect(toastText()).toContain('Изъятие партии AT-2026-000457 уже подтверждено: список обновлён.');
    answer = 'gone';
    await confirmOnce();
    expect(toastText()).toContain('Задача больше не ваша (держатель изменился): список обновлён.');
  });

  it('each task keeps its own Idempotency-Key: A failed, B tried, A again repeats the key of A (BR-11)', async () => {
    const B_ID = 'aa6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
    const b = task({
      id: B_ID,
      batch: {
        ...(task().batch as Json),
        id: 'ab5f7b9d-1f3a-4c5e-9b7d-1f3a5c7e9b1d',
        publicCode: 'AT-2026-000458',
      },
    });
    const keys: { id: string; key: string }[] = [];
    server.use(
      contractResponse('listRecallTasks', {
        body: pageOf([task({ dueAt: dueSoon() }), { ...b, dueAt: dueSoon() }]),
      }),
      http.post(`${API_BASE}/recall-tasks/:id/confirm`, ({ request, params }) => {
        keys.push({ id: params.id as string, key: request.headers.get('Idempotency-Key')! });
        return HttpResponse.error();
      }),
    );
    await open('/recall-tasks', 'Задачи отзыва');
    const attempt = async (code: string) => {
      await userEvent.click(await screen.findByRole('button', { name: `Изъято: ${code}` }));
      const dialog = await screen.findByRole('dialog', { name: `Изъятие партии ${code}` });
      await userEvent.type(within(dialog).getByLabelText('Код партии для подтверждения'), code);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Подтвердить изъятие' }));
      await within(dialog).findByRole('alert');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    };
    await attempt('AT-2026-000457');
    await attempt('AT-2026-000458');
    await attempt('AT-2026-000457');
    expect(keys.map((k) => k.id)).toEqual([task().id, B_ID, task().id]);
    expect(keys[2]!.key).toBe(keys[0]!.key);
    expect(keys[1]!.key).not.toBe(keys[0]!.key);
  });

  it('an empty active list offers every task; «Все» is the explicit status=all', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      contractResponse('listRecallTasks', {
        body: pageOf([]),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    const { router } = await open('/recall-tasks', 'Задачи отзыва');
    expect(await screen.findByText('Задач изъятия нет.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Все задачи' }));
    await waitFor(() => expect(router.state.location.search).toBe('?status=all'));
    await waitFor(() => expect(seen.at(-1)!.has('status')).toBe(false));
  });

  it('a confirmed task shows who confirmed it and when; no «Изъято»', async () => {
    server.use(
      contractResponse('listRecallTasks', { body: pageOf([contractExample('confirmRecallTask').body]) }),
    );
    await open('/recall-tasks?status=all', 'Задачи отзыва');
    const row = (await screen.findByRole('link', { name: 'AT-2026-000457' })).closest('tr')!;
    expect(within(row).getByText('Изъято')).toHaveAttribute('data-tone', 'ok');
    expect(within(row).getByText(/Кузнецова Мария Олеговна/)).toBeInTheDocument();
    expect(within(row).queryByRole('button')).toBeNull();
  });
});

describe('/recalls', () => {
  it('the registry: source batch link to the card, status, trigger, progress «N из M»; «Запустить отзыв»', async () => {
    const item = { ...recall() };
    for (const k of ['openedBy', 'labTestId', 'complaintId', 'batches', 'tasks', 'version']) delete item[k];
    let query: URLSearchParams | null = null;
    server.use(
      asInspector(),
      contractResponse('listRecalls', {
        body: pageOf([item]),
        onRequest: (r) => void (query = new URL(r.url).searchParams),
      }),
    );
    const { router } = await open('/recalls', 'Отзывы');
    const link = await screen.findByRole('link', { name: 'AT-2026-000123' });
    expect(link).toHaveAttribute('href', `/recalls/${RECALL_ID}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText('Открыт')).toHaveAttribute('data-tone', 'danger');
    expect(within(row).getByText('Решение инспектора')).toBeInTheDocument();
    expect(within(row).getByText('0 из 1')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Запустить отзыв' })[0]).toHaveAttribute(
      'href',
      '/recalls/new',
    );
    await openFilters();
    await userEvent.selectOptions(screen.getByLabelText('Статус'), 'Закрыт');
    await waitFor(() => expect(query!.get('status')).toBe('CLOSED'));
    expect(new URLSearchParams(router.state.location.search).get('status')).toBe('CLOSED');
  });

  it('an empty registry', async () => {
    server.use(asInspector(), contractResponse('listRecalls', { body: pageOf([]) }));
    await open('/recalls', 'Отзывы');
    expect(await screen.findByText('Отзывов пока нет.')).toBeInTheDocument();
  });
});

describe('/recalls/:id', () => {
  it('reason, source, trigger, progress «Подтверждено N из M», affected batches and the tasks with their timers', async () => {
    const body = recall({ tasks: [task({ dueAt: dueSoon() })] });
    server.use(asInspector(), contractResponse('getRecall', { body }));
    await open(`/recalls/${RECALL_ID}`, 'Отзыв AT-2026-000123');
    expect(
      screen.getByText('Жалобы покупателей на горечь муки, партия зерна связана с нарушением'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'AT-2026-000123' })[0]).toHaveAttribute(
      'href',
      `/batches/${(recall().sourceBatch as Json).id}`,
    );
    expect(screen.getByText('Решение инспектора')).toBeInTheDocument();
    expect(screen.getByText('Соколова Анна Викторовна')).toBeInTheDocument();
    const progress = screen.getByRole('progressbar', { name: 'Подтверждено' });
    expect(progress).toHaveAttribute('max', '1');
    expect(progress).toHaveAttribute('value', '0');
    expect(screen.getByText('0 из 1')).toBeInTheDocument();
    const affected = screen.getByRole('table', { name: 'Затронутые партии' });
    const derived = within(affected).getByText('AT-2026-000457').closest('tr')!;
    expect(within(derived).getByText('Производная, уровень 1')).toBeInTheDocument();
    expect(within(derived).getByText('В продаже')).toBeInTheDocument();
    expect(within(derived).getByText('Отозвана')).toBeInTheDocument();
    const tasks = screen.getByRole('table', { name: 'Задачи изъятия' });
    const row = within(tasks).getByText('AT-2026-000457').closest('tr')!;
    expect(within(row).getByText('ООО «Кубань-Маркет»')).toBeInTheDocument();
    expect(within(row).getByText('осталось 2 ч 30 мин')).toBeInTheDocument();
  });

  it('a recall from a complaint links the complaint; a closed one shows its closing time and no timers', async () => {
    const complaintId = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b';
    const closed = recall({
      trigger: 'COMPLAINT',
      complaintId,
      status: 'CLOSED',
      closedAt: '2026-09-24T15:20:00Z',
      progress: { confirmed: 1, total: 1, overdue: 0 },
      tasks: [contractExample('confirmRecallTask').body],
      version: 2,
    });
    server.use(asInspector(), contractResponse('getRecall', { body: closed }));
    await open(`/recalls/${RECALL_ID}`, 'Отзыв AT-2026-000123');
    expect(screen.getByRole('link', { name: 'Открыть жалобу' })).toHaveAttribute(
      'href',
      `/complaints/${complaintId}`,
    );
    expect(screen.getByText('Закрыт', { selector: '.at-chip' })).toHaveAttribute('data-tone', 'ok');
    expect(screen.getByText('1 из 1')).toBeInTheDocument();
    expect(screen.queryByText(/^осталось|^просрочено на/)).toBeNull();
  });

  it('a recall notification (another tab confirmed the last task, the recall closed) reads the card again', async () => {
    let reads = 0;
    server.use(
      asInspector(),
      contractResponse('getRecall', {
        body: recall({ tasks: [task({ dueAt: dueSoon() })] }),
        onRequest: () => void reads++,
      }),
    );
    await open(`/recalls/${RECALL_ID}`, 'Отзыв AT-2026-000123');
    const before = reads;
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    FakeEventSource.last!.emit('notification', {
      id: 99,
      type: 'RECALL',
      payload: { event: 'CLOSED', publicCode: 'AT-2026-000123', recallId: RECALL_ID },
      readAt: null,
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it('404: not found with a way back to the registry', async () => {
    server.use(
      asInspector(),
      http.get(`${API_BASE}/recalls/:id`, () =>
        HttpResponse.json(problem(404, 'NOT_FOUND'), { status: 404 }),
      ),
    );
    await open(`/recalls/${RECALL_ID}`, 'Отзыв');
    expect(await screen.findByText('Отзыв не найден.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'К реестру отзывов' })).toHaveAttribute('href', '/recalls');
  });
});

describe('/recalls/new', () => {
  const BATCH = contractExample('getBatch').body as Json;
  const fillAndConfirm = async (reason = 'Нарушение режима пастеризации') => {
    await userEvent.type(await screen.findByLabelText('Причина'), reason);
    await userEvent.click(screen.getByRole('button', { name: 'Запустить отзыв' }));
    const dialog = await screen.findByRole('dialog', { name: `Запустить отзыв партии ${BATCH.publicCode}` });
    const confirm = within(dialog).getByRole('button', { name: 'Запустить отзыв' });
    expect(confirm).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText('Код партии для подтверждения'),
      BATCH.publicCode as string,
    );
    await userEvent.click(confirm);
    return dialog;
  };

  it('the batch of the link; confirmed with its code; 201 → the new recall card', async () => {
    let body: unknown = null;
    server.use(
      asInspector(),
      contractResponse('createRecall', {
        status: 201,
        onRequest: async (r) => void (body = await r.json()),
      }),
    );
    const { router } = await open(`/recalls/new?batchId=${BATCH.id}`, 'Новый отзыв');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Исходная партия' })).toHaveValue(BATCH.publicCode),
    );
    await fillAndConfirm();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/recalls/${RECALL_ID}`));
    expect(body).toEqual({
      sourceBatchId: BATCH.id,
      reason: 'Нарушение режима пастеризации',
      blockUpstream: false,
    });
    expect(toastText('polite')).toContain('Отзыв по партии AT-2026-000123 запущен');
  });

  it('200: the recall already open for the batch is shown, and said so', async () => {
    server.use(asInspector(), contractResponse('createRecall', { status: 200 }));
    const { router } = await open(`/recalls/new?batchId=${BATCH.id}`, 'Новый отзыв');
    await screen.findByDisplayValue(new RegExp(BATCH.publicCode as string));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Отозвать и партии-источники' }));
    await fillAndConfirm();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/recalls/${RECALL_ID}`));
    expect(toastText() + toastText('polite')).toContain(
      'По партии AT-2026-000123 уже открыт отзыв — показан он.',
    );
  });

  it('client checks: a batch and a reason are required; nothing is sent', async () => {
    let calls = 0;
    server.use(asInspector(), contractResponse('createRecall', { onRequest: () => void calls++ }));
    await open('/recalls/new', 'Новый отзыв');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить отзыв' }));
    expect(await screen.findByRole('combobox', { name: 'Исходная партия' })).toHaveAccessibleDescription(
      'Обязательное поле',
    );
    expect(screen.getByLabelText('Причина')).toHaveAccessibleDescription('Обязательное поле');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole('combobox', { name: 'Исходная партия' })).toHaveFocus();
  });

  it('the source batch is found by its code in the registry', async () => {
    let q: string | null = null;
    server.use(
      asInspector(),
      contractResponse('listBatches', { onRequest: (r) => void (q = new URL(r.url).searchParams.get('q')) }),
    );
    await open('/recalls/new', 'Новый отзыв');
    await userEvent.type(screen.getByRole('combobox', { name: 'Исходная партия' }), '000123');
    const list = await screen.findByRole('listbox', { name: 'Исходная партия' });
    await userEvent.click((await within(list).findAllByRole('option'))[0]!);
    expect(q).toBe('000123');
    expect(screen.getByRole('combobox', { name: 'Исходная партия' })).toHaveValue(BATCH.publicCode);
  });

  it('while the batch of the link is still read, nothing can be confirmed (its code is not known yet)', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let posts = 0;
    server.use(
      asInspector(),
      contractResponse('getBatch', { onRequest: () => held }),
      contractResponse('createRecall', { status: 201, onRequest: () => void posts++ }),
    );
    await open(`/recalls/new?batchId=${BATCH.id}`, 'Новый отзыв');
    await userEvent.type(screen.getByLabelText('Причина'), 'Причина отзыва');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить отзыв' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole('dialog')).toBeNull();
    release();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Исходная партия' })).toHaveValue(BATCH.publicCode),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Запустить отзыв' }));
    const dialog = await screen.findByRole('dialog', { name: `Запустить отзыв партии ${BATCH.publicCode}` });
    expect(within(dialog).getByRole('button', { name: 'Запустить отзыв' })).toBeDisabled();
    expect(posts).toBe(0);
  });

  it('the batch of the link fails to load: said on the field; no confirmation, nothing sent', async () => {
    let posts = 0;
    server.use(
      asInspector(),
      http.get(`${API_BASE}/batches/:id`, () => HttpResponse.json(problem(500, 'INTERNAL'), { status: 500 })),
      contractResponse('createRecall', { status: 201, onRequest: () => void posts++ }),
    );
    await open(`/recalls/new?batchId=${BATCH.id}`, 'Новый отзыв');
    expect(
      await screen.findByText('Партия не загрузилась — найдите её по коду.', {}, { timeout: 10000 }),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Причина'), 'Причина отзыва');
    await userEvent.click(screen.getByRole('button', { name: 'Запустить отзыв' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Исходная партия' })).toHaveFocus();
    expect(posts).toBe(0);
  });

  it('the code dialog never confirms with an unknown (empty) code', () => {
    render(
      <CodeConfirmDialog
        open
        title="x"
        text={null}
        code=""
        confirmLabel="Запустить отзыв"
        busy={false}
        wait={0}
        message={null}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Запустить отзыв' })).toBeDisabled();
  });

  it('400 on the batch (gone meanwhile): said on the field, the dialog closes', async () => {
    server.use(
      asInspector(),
      http.post(`${API_BASE}/recalls`, () =>
        HttpResponse.json(
          problem(400, 'VALIDATION', { errors: { sourceBatchId: ['validation.notFound'] } }),
          {
            status: 400,
          },
        ),
      ),
    );
    await open(`/recalls/new?batchId=${BATCH.id}`, 'Новый отзыв');
    await screen.findByDisplayValue(new RegExp(BATCH.publicCode as string));
    await fillAndConfirm();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('combobox', { name: 'Исходная партия' })).toHaveAccessibleDescription(
      'Запись не найдена',
    );
  });
});
