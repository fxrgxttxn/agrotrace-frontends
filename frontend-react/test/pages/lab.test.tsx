import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { File as NodeFile } from 'node:buffer';
import { server } from '../setup';
import { contractExample, contractResponse, type Json } from '../msw/fromContract';
import { asMe, pageOf, toastText } from '../msw/data';
import { renderApp } from '../app/renderApp';

const TEST_ID = '8f0a2c4e-6a8c-4e0a-9c2e-4a6c8e0a2c4e';
const NITRATES = '2b4d6f8a-0c2e-4a4b-8d6f-8a0c2e4b6d8f';
const LEAD = '3c5e7a9b-1d3f-4b5c-9e7a-9b1d3f5c7e9a';
const LAB_ORG = {
  id: '5a7c9e1b-3d5f-4a7c-9e1b-3d5f7a9c1e3b',
  name: 'ИЛ «Кубаньтест»',
  type: 'LAB',
  logoUrl: null,
};
const asLab = () => asMe({ roles: ['LAB'], organization: LAB_ORG });

const done = (extra: Json = {}): Json => ({ ...(contractExample('getLabTest').body as Json), ...extra });
const pending = (extra: Json = {}): Json => {
  const base = done();
  return {
    ...base,
    batch: { ...base.batch, status: 'OnTest' },
    status: 'SAMPLED',
    conclusion: null,
    completedAt: null,
    results: [],
    recallId: null,
    version: 2,
    actions: ['submitResults', 'uploadProtocol'],
    ...extra,
  };
};
const listItem = (extra: Json = {}): Json => {
  const t = pending();
  const keys = [
    'id',
    'batch',
    'lab',
    'reason',
    'status',
    'conclusion',
    'dueAt',
    'overdue',
    'createdAt',
    'sampledAt',
    'completedAt',
    'hasProtocol',
  ];
  return { ...Object.fromEntries(keys.map((k) => [k, t[k]])), ...extra };
};

async function open(path: string, title: string | RegExp) {
  const utils = renderApp(path);
  await screen.findByRole('heading', { level: 1, name: title });
  return utils;
}
async function openFilters() {
  const toggle = document.querySelector<HTMLElement>('.at-page__filters-toggle');
  if (toggle && !toggle.closest('details')!.open) await userEvent.click(toggle);
}
const card = (title: string) => screen.getByRole('heading', { level: 2, name: title }).closest('article')!;

describe('/lab/tests', () => {
  it('the queue: batch link to the card, status, reason, due date with «Просрочен»; the default order', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      asLab(),
      contractResponse('listLabTests', {
        body: pageOf([listItem(), listItem({ id: '9a1c3e5a-7c9e-4b1d-8f3a-5c7e9b1d3f5a', overdue: true })]),
        onRequest: (r) => void (query = new URL(r.url).searchParams),
      }),
    );
    await open('/lab/tests', 'Очередь проб');
    const links = await screen.findAllByRole('link', { name: 'AT-2026-000123' });
    expect(links[0]).toHaveAttribute('href', `/lab/tests/${TEST_ID}`);
    const row = links[0]!.closest('tr')!;
    expect(within(row).getByText('Пшеница озимая')).toBeInTheDocument();
    expect(within(row).getByText('Проба отобрана')).toHaveAttribute('data-tone', 'move');
    expect(within(row).getByText('Риск-модель')).toBeInTheDocument();
    expect(within(row).queryByText('Просрочен')).toBeNull();
    expect(within(links[1]!.closest('tr')!).getByText('Просрочен')).toHaveAttribute('data-tone', 'danger');
    expect(query!.get('page')).toBe('1');
    expect(query!.has('sort')).toBe(false);
    expect(query!.getAll('status')).toEqual(['QUEUED', 'SAMPLED', 'ESCALATED']);
  });

  it('«Все» is an explicit choice (status=all, nothing sent); «Активные» goes back to the default', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asLab(),
      contractResponse('listLabTests', {
        body: pageOf([listItem()]),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    const { router } = await open('/lab/tests', 'Очередь проб');
    await screen.findAllByRole('link', { name: 'AT-2026-000123' });
    await openFilters();
    expect(screen.getByLabelText('Статус')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Активные' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Статус'), 'Все');
    await waitFor(() => expect(seen.at(-1)!.has('status')).toBe(false));
    expect(new URLSearchParams(router.state.location.search).get('status')).toBe('all');
    await userEvent.selectOptions(screen.getByLabelText('Статус'), 'Активные');
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.getByLabelText('Статус')).toHaveValue('');
  });

  it('an empty active queue offers every test', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asLab(),
      contractResponse('listLabTests', {
        body: pageOf([]),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    const { router } = await open('/lab/tests', 'Очередь проб');
    await userEvent.click(await screen.findByRole('button', { name: 'Все анализы' }));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('status')).toBe('all'));
    await waitFor(() => expect(seen.at(-1)!.has('status')).toBe(false));
  });

  it('«Все» with nothing found is an empty queue (no button); `status=all` with other statuses becomes `status=all`', async () => {
    server.use(asLab(), contractResponse('listLabTests', { body: pageOf([]) }));
    const { router } = await open('/lab/tests?status=all&status=QUEUED', 'Очередь проб');
    await waitFor(() => expect(router.state.location.search).toBe('?status=all'));
    const empty = (await screen.findByText('Проб в очереди нет.')).closest('.at-empty')!;
    expect(within(empty as HTMLElement).queryByRole('button')).toBeNull();
    expect(within(empty as HTMLElement).queryByRole('link')).toBeNull();
  });

  it('filters go to the server and stay in the URL; unknown values are dropped', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asLab(),
      contractResponse('listLabTests', {
        body: pageOf([listItem()]),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    const { router } = await open('/lab/tests?status=BAD&overdue=maybe&sort=version,asc', 'Очередь проб');
    await screen.findAllByRole('link', { name: 'AT-2026-000123' });
    expect(router.state.location.search).toBe('');
    expect(seen.at(-1)!.getAll('status')).toEqual(['QUEUED', 'SAMPLED', 'ESCALATED']);
    await openFilters();
    await userEvent.selectOptions(screen.getByLabelText('Статус'), 'Ожидает отбора пробы');
    await waitFor(() => expect(seen.at(-1)!.getAll('status')).toEqual(['QUEUED']));
    await userEvent.selectOptions(screen.getByLabelText('Просрочка'), 'Только просроченные');
    await waitFor(() => expect(seen.at(-1)!.get('overdue')).toBe('true'));
    await userEvent.selectOptions(screen.getByLabelText('Основание'), 'Назначен инспектором');
    await waitFor(() => expect(seen.at(-1)!.getAll('reason')).toEqual(['INSPECTOR']));
    await userEvent.selectOptions(screen.getByLabelText('Заключение'), 'Превышение нормативов');
    await waitFor(() => expect(seen.at(-1)!.get('conclusion')).toBe('FAIL'));
    const search = new URLSearchParams(router.state.location.search);
    expect(search.get('overdue')).toBe('true');
    expect(search.get('conclusion')).toBe('FAIL');
  });

  it('empty queue: one line; nothing found with filters: «Сбросить фильтры»; a 400: the reset', async () => {
    server.use(asLab(), contractResponse('listLabTests', { body: pageOf([]) }));
    const { router } = await open('/lab/tests', 'Очередь проб');
    expect(await screen.findByText('Проб в очереди нет.')).toBeInTheDocument();
    router.navigate('/lab/tests?overdue=true');
    await userEvent.click(await screen.findByRole('button', { name: 'Сбросить фильтры' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    server.use(contractResponse('listLabTests', { status: 400 }));
    router.navigate('/lab/tests?q=AT');
    expect(await screen.findByText('Список нельзя показать с такими фильтрами.')).toBeInTheDocument();
  });
});

describe('/lab/tests/:id — results', () => {
  it('a sample answer after the person left the card: no navigation, the success still said in the app region', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    server.use(
      asLab(),
      contractResponse('getLabTest', {
        body: pending({
          status: 'QUEUED',
          sampledAt: null,
          actions: ['sample', 'submitResults', 'uploadProtocol'],
        }),
      }),
      contractResponse('registerLabSample', { body: pending({ version: 3 }), onRequest: () => held }),
      contractResponse('listLabTests', { body: pageOf([]) }),
    );
    const { router } = await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.click(await screen.findByRole('button', { name: 'Зарегистрировать пробу' }));
    await act(() => router.navigate('/lab/tests'));
    await screen.findByRole('heading', { level: 1, name: 'Очередь проб' });
    release();
    await new Promise((r) => setTimeout(r, 150));
    expect(toastText('polite')).toContain('Проба партии AT-2026-000123 зарегистрирована');
    expect(router.state.location.pathname).toBe('/lab/tests');
  });

  it('register the sample: POST with If-Match, the card changes', async () => {
    let ifMatch: string | null = null;
    server.use(
      asLab(),
      contractResponse('getLabTest', {
        body: pending({
          status: 'QUEUED',
          sampledAt: null,
          actions: ['sample', 'submitResults', 'uploadProtocol'],
        }),
      }),
      contractResponse('registerLabSample', {
        body: pending({ version: 3 }),
        onRequest: (r) => void (ifMatch = r.headers.get('If-Match')),
      }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.click(await screen.findByRole('button', { name: 'Зарегистрировать пробу' }));
    await waitFor(() =>
      expect(toastText('polite')).toContain('Проба партии AT-2026-000123 зарегистрирована'),
    );
    expect(ifMatch).toBe('2');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Зарегистрировать пробу' })).toBeNull());
  });

  it('every indicator against its norm, live: «Превышение» / «В норме» and the conclusion (BR-02)', async () => {
    server.use(asLab(), contractResponse('getLabTest', { body: pending() }));
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    const nitrates = await screen.findByLabelText('Значение: Нитраты');
    const lead = screen.getByLabelText('Значение: Свинец');
    const rowOf = (el: HTMLElement) => el.closest('tr')!;
    expect(within(rowOf(nitrates)).getByText('не более 500 мг/кг')).toBeInTheDocument();
    await userEvent.type(nitrates, '500');
    expect(within(rowOf(nitrates)).getByText('В норме')).toHaveAttribute('data-tone', 'ok');
    await userEvent.type(nitrates, ',0001');
    expect(within(rowOf(nitrates)).getByText('Превышение')).toHaveAttribute('data-tone', 'danger');
    await userEvent.type(lead, '0,15');
    expect(within(rowOf(lead)).getByText('В норме')).toBeInTheDocument();
    expect(screen.getByText('Заключение: Превышение нормативов')).toBeInTheDocument();
    await userEvent.clear(nitrates);
    await userEvent.type(nitrates, '499,9');
    expect(screen.getByText('Заключение: Соответствует нормативам')).toBeInTheDocument();
  });

  it('PASS: all values in one request with If-Match; the card shows the results', async () => {
    let body: Json | null = null;
    let ifMatch: string | null = null;
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending(), once: true }),
      contractResponse('submitLabResults', {
        body: done({ conclusion: 'PASS', recallId: null, results: [], actions: ['uploadProtocol'] }),
        onRequest: async (r) => {
          body = (await r.clone().json()) as Json;
          ifMatch = r.headers.get('If-Match');
        },
      }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.type(await screen.findByLabelText('Значение: Нитраты'), '450');
    await userEvent.type(screen.getByLabelText('Значение: Свинец'), '0,15');
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    await waitFor(() =>
      expect(toastText('polite')).toContain('Результаты внесены: Соответствует нормативам'),
    );
    expect(ifMatch).toBe('2');
    expect(body).toEqual({
      results: [
        { indicatorId: NITRATES, value: '450' },
        { indicatorId: LEAD, value: '0.15' },
      ],
    });
  });

  it('required values and the number format are checked before sending', async () => {
    let sent = 0;
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending() }),
      contractResponse('submitLabResults', { onRequest: () => void sent++ }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.type(await screen.findByLabelText('Значение: Свинец'), '0,1234567');
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    expect(await screen.findByLabelText('Значение: Нитраты')).toHaveAccessibleDescription(
      'Обязательное поле',
    );
    expect(screen.getByLabelText('Значение: Свинец')).toHaveAccessibleDescription(
      'Недопустимый формат числа',
    );
    expect(screen.getByLabelText('Значение: Нитраты')).toHaveFocus();
    expect(sent).toBe(0);
  });

  it('FAIL starts a recall: a dialog asks for the batch code first', async () => {
    let sent = 0;
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending(), once: true }),
      contractResponse('submitLabResults', { body: done(), onRequest: () => void sent++ }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.type(await screen.findByLabelText('Значение: Нитраты'), '612');
    await userEvent.type(screen.getByLabelText('Значение: Свинец'), '0,15');
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Превышение нормативов: партия AT-2026-000123',
    });
    const confirm = within(dialog).getByRole('button', { name: 'Внести и запустить отзыв' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Код партии для подтверждения'), 'at-2026-000123');
    await userEvent.click(confirm);
    await waitFor(() => expect(toastText('polite')).toContain('По партии AT-2026-000123 запущен отзыв'));
    expect(sent).toBe(1);
    const results = await screen.findByRole('table', { name: 'Показатели' });
    expect(
      within(within(results).getByText('Нитраты').closest('tr')!).getByText('Превышение'),
    ).toBeInTheDocument();
  });

  it('VERSION_CONFLICT: the card is read again, the typed values stay, the retry uses the new version', async () => {
    const ifMatch: (string | null)[] = [];
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending(), once: true }),
      contractResponse('getLabTest', { body: pending({ version: 3 }) }),
      contractResponse('submitLabResults', {
        status: 409,
        example: 'versionConflict',
        once: true,
        onRequest: (r) => void ifMatch.push(r.headers.get('If-Match')),
      }),
      contractResponse('submitLabResults', {
        body: done({ conclusion: 'PASS', recallId: null, results: [], actions: [] }),
        onRequest: (r) => void ifMatch.push(r.headers.get('If-Match')),
      }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.type(await screen.findByLabelText('Значение: Нитраты'), '450');
    await userEvent.type(screen.getByLabelText('Значение: Свинец'), '0,15');
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    await waitFor(() => expect(toastText()).toContain('Анализ изменился'));
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByLabelText('Значение: Нитраты')).toHaveValue('450');
    expect(document.activeElement).not.toBe(document.body);
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    await waitFor(() => expect(ifMatch).toEqual(['2', '3']));
  });

  it('a 400 of the indicator set re-reads the card, says so, keeps the values of the norms that stayed', async () => {
    let reads = 0;
    const CADMIUM = '5e7a9c1e-3b5d-4f7a-9c1e-3b5d7f9a1c3e';
    const base = pending();
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: base, once: true, onRequest: () => void reads++ }),
      contractResponse('getLabTest', {
        onRequest: () => void reads++,
        body: pending({
          version: 3,
          norms: [
            base.norms[0],
            { indicatorId: CADMIUM, name: 'Кадмий', unit: 'мг/кг', maxValue: '0.100000' },
          ],
        }),
      }),
      contractResponse('submitLabResults', { status: 400, example: 'mismatch' }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.type(await screen.findByLabelText('Значение: Нитраты'), '450');
    await userEvent.type(screen.getByLabelText('Значение: Свинец'), '0,15');
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    await waitFor(() => expect(toastText()).toContain('Нормативы анализа изменились'));
    expect(await screen.findByLabelText('Значение: Кадмий')).toHaveValue('');
    expect(reads).toBe(2);
    expect(screen.getByLabelText('Значение: Нитраты')).toHaveValue('450');
    expect(screen.queryByLabelText('Значение: Свинец')).toBeNull();
  });

  it('INVALID_TRANSITION (results already entered): the done card, the state said, the focus on the title', async () => {
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending(), once: true }),
      contractResponse('getLabTest', { body: done({ actions: [] }) }),
      contractResponse('submitLabResults', { status: 409, example: 'invalidTransition' }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.type(await screen.findByLabelText('Значение: Нитраты'), '450');
    await userEvent.type(screen.getByLabelText('Значение: Свинец'), '0,15');
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    await waitFor(() => expect(toastText()).toContain('Анализ уже в статусе «Завершён»'));
    await waitFor(() => expect(screen.queryByLabelText('Значение: Нитраты')).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Анализ AT-2026-000123' })).toHaveFocus(),
    );
  });

  it('a 400 on one value (results[1].value) is that row field error', async () => {
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending() }),
      contractResponse('submitLabResults', {
        status: 400,
        body: {
          type: '/problems/validation',
          title: 'Validation failed',
          status: 400,
          code: 'VALIDATION',
          errors: { 'results[1].value': ['validation.decimal.format'] },
        },
      }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.type(await screen.findByLabelText('Значение: Нитраты'), '450');
    await userEvent.type(screen.getByLabelText('Значение: Свинец'), '0,15');
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Значение: Свинец')).toHaveAccessibleDescription(
        'Недопустимый формат числа',
      ),
    );
    expect(screen.getByLabelText('Значение: Свинец')).toHaveFocus();
    expect(screen.getByLabelText('Значение: Нитраты')).not.toHaveAccessibleDescription();
  });

  it('429: the wait on «Внести результаты», the focus comes back to it; a 403 is said, values stay', async () => {
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending() }),
      contractResponse('submitLabResults', { status: 429, headers: { 'Retry-After': '1' }, once: true }),
      contractResponse('submitLabResults', { status: 403 }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.type(await screen.findByLabelText('Значение: Нитраты'), '450');
    await userEvent.type(screen.getByLabelText('Значение: Свинец'), '0,15');
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    expect(await screen.findByRole('button', { name: /^Повторить через 1 с$/ })).toBeDisabled();
    expect(toastText() + toastText('polite')).toContain('повторите через 1 с');
    const button = await screen.findByRole('button', { name: 'Внести результаты' }, { timeout: 3000 });
    await waitFor(() => expect(button).toHaveFocus());
    await userEvent.click(button);
    await waitFor(() => expect(toastText()).toContain('Недостаточно прав'));
    expect(toastText()).not.toBe('');
    expect(screen.getByLabelText('Значение: Нитраты')).toHaveValue('450');
  });

  it('a conflict while the FAIL dialog is open: said in the dialog, the confirmation then uses the new version', async () => {
    const ifMatch: (string | null)[] = [];
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending(), once: true }),
      contractResponse('getLabTest', { body: pending({ version: 3 }) }),
      contractResponse('submitLabResults', {
        status: 409,
        example: 'versionConflict',
        once: true,
        onRequest: (r) => void ifMatch.push(r.headers.get('If-Match')),
      }),
      contractResponse('submitLabResults', {
        body: done(),
        onRequest: (r) => void ifMatch.push(r.headers.get('If-Match')),
      }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.type(await screen.findByLabelText('Значение: Нитраты'), '612');
    await userEvent.type(screen.getByLabelText('Значение: Свинец'), '0,15');
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Превышение нормативов: партия AT-2026-000123',
    });
    await userEvent.type(within(dialog).getByLabelText('Код партии для подтверждения'), 'AT-2026-000123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Внести и запустить отзыв' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Анализ изменился');
    await new Promise((r) => setTimeout(r, 200));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Внести и запустить отзыв' }));
    await waitFor(() => expect(ifMatch).toEqual(['2', '3']));
  });

  it('a re-read under the open FAIL dialog that no longer concludes FAIL closes it', async () => {
    const base = pending();
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: base, once: true }),
      contractResponse('getLabTest', {
        body: pending({ version: 3, norms: [{ ...base.norms[0], maxValue: '1000.000000' }, base.norms[1]] }),
      }),
      contractResponse('submitLabResults', { status: 409, example: 'versionConflict' }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.type(await screen.findByLabelText('Значение: Нитраты'), '612');
    await userEvent.type(screen.getByLabelText('Значение: Свинец'), '0,15');
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Превышение нормативов: партия AT-2026-000123',
    });
    await userEvent.type(within(dialog).getByLabelText('Код партии для подтверждения'), 'AT-2026-000123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Внести и запустить отзыв' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Заключение: Соответствует нормативам')).toBeInTheDocument();
    expect(screen.getByLabelText('Значение: Нитраты')).toHaveValue('612');
  });

  it('a re-read under the open FAIL dialog that adds a norm closes it; nothing incomplete is sent; the new field is focused', async () => {
    let sent = 0;
    const CADMIUM = '5e7a9c1e-3b5d-4f7a-9c1e-3b5d7f9a1c3e';
    const base = pending();
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: base, once: true }),
      contractResponse('getLabTest', {
        body: pending({
          version: 3,
          norms: [
            ...base.norms,
            { indicatorId: CADMIUM, name: 'Кадмий', unit: 'мг/кг', maxValue: '0.100000' },
          ],
        }),
      }),
      contractResponse('submitLabResults', {
        status: 400,
        example: 'mismatch',
        onRequest: () => void sent++,
      }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    await userEvent.type(await screen.findByLabelText('Значение: Нитраты'), '612');
    await userEvent.type(screen.getByLabelText('Значение: Свинец'), '0,15');
    await userEvent.click(screen.getByRole('button', { name: 'Внести результаты' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Превышение нормативов: партия AT-2026-000123',
    });
    await userEvent.type(within(dialog).getByLabelText('Код партии для подтверждения'), 'AT-2026-000123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Внести и запустить отзыв' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent).toBe(1);
    const cadmium = await screen.findByLabelText('Значение: Кадмий');
    await waitFor(() => expect(cadmium).toHaveFocus());
    expect(screen.getByLabelText('Значение: Нитраты')).toHaveValue('612');
  });

  it('the live comparison takes only the contract Decimal (no exponent) and is exact at the limit (BR-02: strictly greater)', async () => {
    server.use(asLab(), contractResponse('getLabTest', { body: pending() }));
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    const nitrates = await screen.findByLabelText('Значение: Нитраты');
    const row = nitrates.closest('tr')!;
    await userEvent.type(nitrates, '1e3');
    expect(within(row).queryByText('Превышение')).toBeNull();
    expect(within(row).queryByText('В норме')).toBeNull();
    await userEvent.clear(nitrates);
    await userEvent.type(nitrates, '500,000000');
    expect(within(row).getByText('В норме')).toBeInTheDocument();
    await userEvent.clear(nitrates);
    await userEvent.type(nitrates, '500,000001');
    expect(within(row).getByText('Превышение')).toBeInTheDocument();
  });

  it('a product without norms: the reason, no form', async () => {
    server.use(asLab(), contractResponse('getLabTest', { body: pending({ norms: [] }) }));
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    expect(
      await screen.findByText('Для продукта партии нет нормативов: результаты внести нельзя.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Внести результаты' })).toBeNull();
  });

  it('a done test (read-only): facts, conclusion, results with the server assessment', async () => {
    server.use(asMe({ roles: ['LAB'] }), contractResponse('getLabTest', { body: done({ actions: [] }) }));
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    const results = await screen.findByRole('table', { name: 'Показатели' });
    const row = within(results).getByText('Свинец').closest('tr')!;
    expect(within(row).getByText('0,15 мг/кг')).toBeInTheDocument();
    expect(within(row).getByText('В норме')).toBeInTheDocument();
    expect(screen.getAllByText('Превышение нормативов')[0]).toHaveAttribute('data-tone', 'danger');
    expect(screen.queryByLabelText('Значение: Нитраты')).toBeNull();
    expect(screen.queryByText('Файл')).toBeNull();
  });

  it('404: «Анализ не найден.» with the way back to the queue', async () => {
    server.use(asLab(), contractResponse('getLabTest', { status: 404 }));
    await open(`/lab/tests/${TEST_ID}`, 'Анализ');
    expect(await screen.findByText('Анализ не найден.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'К очереди проб' })).toHaveAttribute('href', '/lab/tests');
  });
});

const pdf = (bytes = 2048, type = 'application/pdf', name = 'protokol.pdf') =>
  new NodeFile([new Uint8Array(bytes)], name, { type }) as unknown as File;
const UndiciFormData = (
  await new Response('', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).formData()
).constructor as typeof FormData;

describe('/lab/tests/:id — protocol', () => {
  beforeEach(() => vi.stubGlobal('FormData', UndiciFormData));
  afterEach(() => vi.unstubAllGlobals());

  it('a PDF up to 10 MB goes as multipart `file`; the card shows the download link', async () => {
    let contentType = '';
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending(), once: true }),
      contractResponse('getLabTest', {
        body: pending({ hasProtocol: true, protocol: contractExample('uploadLabProtocol').body }),
      }),
      contractResponse('uploadLabProtocol', {
        onRequest: (r) => void (contentType = r.headers.get('Content-Type') ?? ''),
      }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    const protocol = within(card('Протокол испытаний'));
    expect(protocol.getByText('Протокол не загружен.')).toBeInTheDocument();
    await userEvent.upload(protocol.getByLabelText('Файл'), pdf(10485760));
    await userEvent.click(protocol.getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(toastText('polite')).toContain('Протокол загружен'));
    expect(contentType).toMatch(/^multipart\/form-data/);
    const link = await within(card('Протокол испытаний')).findByRole('link', { name: 'Скачать протокол' });
    expect(link.getAttribute('href')).toMatch(/^\/api\/v1\/files\//);
  });

  it('more than 10 MB or not a PDF: said at once, nothing sent; a 413 of the server is said the same way', async () => {
    let sent = 0;
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending() }),
      contractResponse('uploadLabProtocol', { status: 413, onRequest: () => void sent++ }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    const protocol = within(card('Протокол испытаний'));
    await userEvent.upload(protocol.getByLabelText('Файл'), pdf(10485761));
    expect(protocol.getByRole('alert')).toHaveTextContent('10 МБ');
    expect(protocol.queryByRole('button', { name: 'Загрузить' })).toBeNull();
    await userEvent.upload(protocol.getByLabelText('Файл'), pdf(100, 'image/png', 'a.png'), {
      applyAccept: false,
    });
    expect(protocol.getByRole('alert')).toHaveTextContent('PDF');
    expect(sent).toBe(0);
    await userEvent.upload(protocol.getByLabelText('Файл'), pdf(1000));
    await userEvent.click(protocol.getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(protocol.getByRole('alert')).toHaveTextContent('10 МБ'));
    expect(sent).toBe(1);
  });

  it('while uploading the file shows its progress; a 415 is said on the file and as the page message', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending() }),
      contractResponse('uploadLabProtocol', { status: 415, onRequest: () => held }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    const protocol = within(card('Протокол испытаний'));
    await userEvent.upload(protocol.getByLabelText('Файл'), pdf(1000));
    await userEvent.click(protocol.getByRole('button', { name: 'Загрузить' }));
    const progress = await protocol.findByRole('progressbar', { name: 'Загрузка protokol.pdf' });
    expect(progress).not.toHaveAttribute('value');
    release();
    await waitFor(() => expect(protocol.getByRole('alert')).toHaveTextContent('PDF'));
    expect(protocol.queryByRole('progressbar')).toBeNull();
    expect(toastText()).toContain('PDF');
  });

  it('429: the upload waits with a countdown and the page says why; the file stays', async () => {
    server.use(
      asLab(),
      contractResponse('getLabTest', { body: pending() }),
      contractResponse('uploadLabProtocol', { status: 429, headers: { 'Retry-After': '1' } }),
    );
    await open(`/lab/tests/${TEST_ID}`, 'Анализ AT-2026-000123');
    const protocol = within(card('Протокол испытаний'));
    await userEvent.upload(protocol.getByLabelText('Файл'), pdf(1000));
    await userEvent.click(protocol.getByRole('button', { name: 'Загрузить' }));
    expect(await protocol.findByRole('button', { name: /^Повторить через 1 с$/ })).toBeDisabled();
    expect(toastText() + toastText('polite')).toContain('повторите через 1 с');
    expect(protocol.getByText('protokol.pdf')).toBeInTheDocument();
    const button = await protocol.findByRole('button', { name: 'Загрузить' }, { timeout: 3000 });
    await waitFor(() => expect(button).toHaveFocus());
  });
});

describe('/batches/:id — unscheduled test (INSPECTOR)', () => {
  const BATCH_ID = '1c3e5a7c-9e1b-4d3f-8a5c-7e9b1d3f5a7c';

  it('a failure of the assignment is said in the dialog only; the page says it once the dialog is closed', async () => {
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      contractResponse('listOrganizations', {
        body: pageOf([{ ...LAB_ORG, region: { code: '23', name: 'Краснодарский край' } }]),
      }),
      contractResponse('getOrganization'),
      contractResponse('createLabTest', { status: 403 }),
    );
    await open(`/batches/${BATCH_ID}`, 'AT-2026-000123');
    await userEvent.click(screen.getByRole('button', { name: 'Назначить анализ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Внеплановый анализ партии AT-2026-000123' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Лаборатория' }), 'Куб');
    await userEvent.click(
      await within(await screen.findByRole('listbox', { name: 'Лаборатория' })).findByRole('option'),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Назначить анализ' }));
    const inDialog = await within(dialog).findByRole('alert');
    const text = inDialog.textContent;
    expect(text).not.toBe('');
    expect(toastText()).toBe('');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(toastText()).toBe(text));
  });

  it('«Назначить анализ»: a laboratory from the directory, POST /lab-tests, the tests tab', async () => {
    let body: Json | null = null;
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      contractResponse('listOrganizations', {
        body: pageOf([{ ...LAB_ORG, region: { code: '23', name: 'Краснодарский край' } }]),
      }),
      contractResponse('getOrganization'),
      contractResponse('listLabTests', { body: pageOf([]) }),
      contractResponse('createLabTest', {
        onRequest: async (r) => void (body = (await r.clone().json()) as Json),
      }),
    );
    const { router } = await open(`/batches/${BATCH_ID}`, 'AT-2026-000123');
    await userEvent.click(screen.getByRole('button', { name: 'Назначить анализ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Внеплановый анализ партии AT-2026-000123' });
    const confirm = within(dialog).getByRole('button', { name: 'Назначить анализ' });
    await userEvent.click(confirm);
    expect(within(dialog).getByRole('combobox', { name: 'Лаборатория' })).toHaveAccessibleDescription(
      'Обязательное поле',
    );
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Лаборатория' }), 'Куб');
    await userEvent.click(
      await within(await screen.findByRole('listbox', { name: 'Лаборатория' })).findByRole('option'),
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(toastText('polite')).toContain('Анализ партии AT-2026-000123 назначен: ИЛ «Кубаньтест»'),
    );
    expect(body).toEqual({ batchId: BATCH_ID, labOrgId: LAB_ORG.id });
    expect(new URLSearchParams(router.state.location.search).get('tab')).toBe('tests');
  });

  it('a 400 on the laboratory is shown on the field; a FARMER has no such button', async () => {
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      contractResponse('listOrganizations', {
        body: pageOf([{ ...LAB_ORG, region: { code: '23', name: 'Краснодарский край' } }]),
      }),
      contractResponse('getOrganization'),
      contractResponse('createLabTest', {
        status: 400,
        body: {
          type: '/problems/validation',
          title: 'Validation failed',
          status: 400,
          code: 'VALIDATION',
          errors: { labOrgId: ['validation.labOrg.type'] },
        },
      }),
    );
    await open(`/batches/${BATCH_ID}`, 'AT-2026-000123');
    await userEvent.click(screen.getByRole('button', { name: 'Назначить анализ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Внеплановый анализ партии AT-2026-000123' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Лаборатория' }), 'Куб');
    await userEvent.click(
      await within(await screen.findByRole('listbox', { name: 'Лаборатория' })).findByRole('option'),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Назначить анализ' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Лаборатория' })).toHaveAccessibleDescription(
        'Организация не является лабораторией',
      ),
    );
  });

  it('FARMER: no «Назначить анализ»', async () => {
    await open(`/batches/${BATCH_ID}`, 'AT-2026-000123');
    expect(screen.queryByRole('button', { name: 'Назначить анализ' })).toBeNull();
  });
});
