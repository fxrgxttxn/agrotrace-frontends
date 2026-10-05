import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { formatLocalDate, formatLocalDateTime } from '@agrotrace/i18n';
import { server } from '../setup';
import { contractExample, contractResponse } from '../msw/fromContract';
import { asMe, dictionaries, pageOf, problem, toastText } from '../msw/data';
import { renderApp } from '../app/renderApp';
import { router } from '../kit/router.svelte';

const FIELD_ID = '2e4a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e';
const field = () => contractExample('getField').body as Record<string, unknown>;
const treatment = (extra: Record<string, unknown> = {}) => ({
  ...((contractExample('listFieldTreatments').body as { items: Record<string, unknown>[] }).items[0] ?? {}),
  ...extra,
});
const future = () => new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');

async function open(path: string, title: string | RegExp) {
  const utils = await renderApp(path);
  await screen.findByRole('heading', { level: 1, name: title });
  return utils;
}

async function openFilters() {
  const toggle = document.querySelector<HTMLElement>('.at-page__filters-toggle');
  if (toggle && !toggle.closest('details')!.open) await userEvent.click(toggle);
}

describe('/fields', () => {
  it('FARMER: the farm’s fields with name link, region, area in ha, last treatment; add button', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      dictionaries(),
      contractResponse('listFields', { onRequest: (r) => void (query = new URL(r.url).searchParams) }),
    );
    await open('/fields', 'Поля');
    const link = await screen.findByRole('link', { name: 'Участок «Восточный-3»' });
    expect(link).toHaveAttribute('href', `/fields/${FIELD_ID}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText('Краснодарский край')).toBeInTheDocument();
    expect(within(row).getByText('124,50')).toBeInTheDocument();
    expect(within(row).getByText(formatLocalDate('2026-06-02T07:00:00Z', 'ru'))).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Хозяйство' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Добавить поле' })[0]).toHaveAttribute('href', '/fields/new');
    expect(query!.get('page')).toBe('1');
    expect(query!.has('sort')).toBe(false);
    expect(query!.has('organizationId')).toBe(false);
  });

  it('search and sort live in the URL and go to the server; a change goes back to page 1', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      dictionaries(),
      contractResponse('listFields', { onRequest: (r) => void seen.push(new URL(r.url).searchParams) }),
    );
    await open('/fields?page=2', 'Поля');
    await screen.findByRole('link', { name: 'Участок «Восточный-3»' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Поиск полей' }), 'вост');
    await waitFor(() => expect(seen.at(-1)!.get('q')).toBe('вост'));
    expect(seen.at(-1)!.get('page')).toBe('1');
    await openFilters();
    await userEvent.selectOptions(await screen.findByLabelText('Регион'), 'Владимирская область');
    await waitFor(() => expect(seen.at(-1)!.get('regionCode')).toBe('33'));
    await userEvent.click(screen.getByRole('button', { name: 'Площадь, га' }));
    await waitFor(() => expect(seen.at(-1)!.get('sort')).toBe('areaHa,asc'));
    expect(location.search).toContain('q=%D0%B2%D0%BE%D1%81%D1%82');
    expect(location.search).toContain('regionCode=33');
    expect(location.search).toContain('sort=areaHa%2Casc');
    expect(screen.getByRole('columnheader', { name: 'Площадь, га' })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('INSPECTOR: every farm’s fields with the farm column; the organization filter sends organizationId', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      dictionaries(),
      contractResponse('listFields', { onRequest: (r) => void seen.push(new URL(r.url).searchParams) }),
      contractResponse('listOrganizations', {
        body: pageOf([
          {
            id: '0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10',
            name: 'КФХ Петров',
            type: 'FARM',
            logoUrl: null,
            region: { code: '23', name: 'Краснодарский край' },
          },
        ]),
      }),
      contractResponse('getOrganization'),
    );
    await open('/fields', 'Поля');
    await screen.findByRole('columnheader', { name: 'Хозяйство' });
    expect(screen.queryByRole('link', { name: 'Добавить поле' })).toBeNull();
    await openFilters();
    await userEvent.type(screen.getByRole('combobox', { name: 'Хозяйство' }), 'Пет');
    await userEvent.click(
      await within(await screen.findByRole('listbox', { name: 'Хозяйство' })).findByRole('option'),
    );
    await waitFor(() => expect(seen.at(-1)!.get('organizationId')).toBe('0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10'));
    expect(location.search).toContain('organizationId=0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10');
  });

  it('FARMER never sends organizationId, even from a pasted URL', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      dictionaries(),
      contractResponse('listFields', { onRequest: (r) => void (query = new URL(r.url).searchParams) }),
    );
    await open('/fields?organizationId=0f8c2d7e-6a41-4b3e-9d25-7c1a9e4b2f10', 'Поля');
    await screen.findByRole('link', { name: 'Участок «Восточный-3»' });
    expect(query!.has('organizationId')).toBe(false);
  });

  it('empty: illustration, one line, «Добавить поле»; with a filter: «Сбросить фильтры» clears the URL', async () => {
    server.use(dictionaries(), contractResponse('listFields', { body: pageOf([]) }));
    await open('/fields', 'Поля');
    expect(await screen.findByText('Полей пока нет.')).toBeInTheDocument();
    await router.goto('/fields?q=zz');
    await userEvent.click(await screen.findByRole('button', { name: 'Сбросить фильтры' }));
    await waitFor(() => expect(location.search).toBe(''));
  });

  it('a failed list says so and retries', async () => {
    server.use(dictionaries(), contractResponse('listFields', { status: 403, once: true }));
    await open('/fields', 'Поля');
    expect(await screen.findByText('Поля не загрузились.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('link', { name: 'Участок «Восточный-3»' })).toBeInTheDocument();
  });

  it('parameters the list does not accept are dropped from the URL and never sent', async () => {
    let query: URLSearchParams | null = null;
    server.use(
      dictionaries(),
      contractResponse('listFields', { onRequest: (r) => void (query = new URL(r.url).searchParams) }),
    );
    await open('/fields?sort=bogus,asc&regionCode=bad!&organizationId=xyz&page=0&q=вост', 'Поля');
    await screen.findByRole('link', { name: 'Участок «Восточный-3»' });
    expect(query!.has('sort')).toBe(false);
    expect(query!.has('regionCode')).toBe(false);
    expect(query!.get('page')).toBe('1');
    expect(query!.get('q')).toBe('вост');
    await waitFor(() => expect(location.search).toBe('?q=%D0%B2%D0%BE%D1%81%D1%82'));
  });
});

describe('/fields/new', () => {
  it('creates a field: area «124,5» → "124.50", region code, no outline → null; opens the new field', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      dictionaries(),
      contractResponse('createField', { onRequest: async (r) => void (body = await r.json()) }),
    );
    await open('/fields/new', 'Новое поле');
    await userEvent.type(await screen.findByLabelText('Название'), 'Участок «Восточный-3»');
    await userEvent.type(screen.getByLabelText('Площадь, га'), '124,5');
    await userEvent.selectOptions(screen.getByLabelText('Регион'), 'Краснодарский край');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить поле' }));
    await waitFor(() => expect(location.pathname).toBe(`/fields/${FIELD_ID}`));
    expect(body).toEqual({
      name: 'Участок «Восточный-3»',
      areaHa: '124.50',
      regionCode: '23',
      geometry: null,
    });
    expect(toastText('polite')).toContain('Поле «Участок «Восточный-3»» добавлено');
  });

  it('outline: a GeoJSON Feature is sent as its Polygon; text that is not a polygon is marked, nothing is sent', async () => {
    let body: Record<string, unknown> | null = null;
    let calls = 0;
    server.use(
      dictionaries(),
      contractResponse('createField', {
        onRequest: async (r) => {
          calls++;
          body = await r.json();
        },
      }),
    );
    await open('/fields/new', 'Новое поле');
    await userEvent.type(await screen.findByLabelText('Название'), 'Северное');
    await userEvent.type(screen.getByLabelText('Площадь, га'), '10');
    await userEvent.selectOptions(screen.getByLabelText('Регион'), 'Владимирская область');
    const outline = screen.getByLabelText('Контур, GeoJSON');
    await userEvent.type(outline, 'не json');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить поле' }));
    expect(await screen.findByText('Вставьте GeoJSON с контуром типа Polygon')).toBeInTheDocument();
    expect(outline).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toBe(0);
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [39, 45],
          [39.1, 45],
          [39.1, 45.1],
          [39, 45],
        ],
      ],
    };
    await userEvent.clear(outline);
    await userEvent.click(outline);
    await userEvent.paste(JSON.stringify({ type: 'Feature', properties: {}, geometry: polygon }));
    await userEvent.click(screen.getByRole('button', { name: 'Добавить поле' }));
    await waitFor(() => expect(calls).toBe(1));
    expect(body!.geometry).toEqual(polygon);
    expect(body!.areaHa).toBe('10.00');
  });

  it('server 400: each error under its field, errors inside the outline under «Контур»', async () => {
    server.use(
      dictionaries(),
      contractResponse('createField', {
        status: 400,
        body: problem(400, 'VALIDATION', {
          errors: {
            regionCode: ['validation.notFound'],
            'geometry.coordinates[0]': ['validation.geometry.ringNotClosed'],
          },
        }),
      }),
    );
    await open('/fields/new', 'Новое поле');
    await userEvent.type(await screen.findByLabelText('Название'), 'Северное');
    await userEvent.type(screen.getByLabelText('Площадь, га'), '10');
    await userEvent.selectOptions(screen.getByLabelText('Регион'), 'Владимирская область');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить поле' }));
    expect(await screen.findByText('Запись не найдена')).toBeInTheDocument();
    expect(screen.getByText('Контур должен быть замкнут')).toBeInTheDocument();
    expect(screen.getByLabelText('Регион')).toHaveFocus();
  });
});

describe('/fields/:id', () => {
  it('the card and the treatment journal; «Изменить» only within the 24 h window', async () => {
    server.use(
      dictionaries(),
      contractResponse('listFieldTreatments', {
        body: pageOf([
          treatment({ editableUntil: future() }),
          treatment({ id: '6a8c0e2a-4c6e-4a8c-9e0a-2c4e6a8c0e2b', appliedAt: '2026-05-01T07:00:00Z' }),
        ]),
      }),
    );
    await open(`/fields/${FIELD_ID}`, 'Участок «Восточный-3»');
    expect(screen.getByText('Краснодарский край')).toBeInTheDocument();
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('1,500 л/га')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(formatLocalDateTime('2026-06-02T07:00:00Z', 'ru'))).toBeInTheDocument();
    expect(within(rows[0]!).getByText(formatLocalDateTime('2026-07-02T07:00:00Z', 'ru'))).toBeInTheDocument();
    expect(
      within(rows[0]!).getByRole('button', {
        name: `Изменить обработку: Хлорпирифос, ${formatLocalDate('2026-06-02T07:00:00Z', 'ru')}`,
      }),
    ).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'Зарегистрировать партию' })).toHaveAttribute(
      'href',
      `/batches/new?fieldId=${FIELD_ID}`,
    );
  });

  it('records a treatment: dose «1,5» → "1.500", local date and time → the UTC instant', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      dictionaries(),
      contractResponse('createTreatment', { onRequest: async (r) => void (body = await r.json()) }),
    );
    await open(`/fields/${FIELD_ID}`, 'Участок «Восточный-3»');
    await userEvent.click(await screen.findByRole('button', { name: 'Записать обработку' }));
    const dialog = await screen.findByRole('dialog', { name: 'Записать обработку' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Препарат'), 'Хлорпирифос');
    await userEvent.type(within(dialog).getByLabelText('Доза'), '1,5');
    await userEvent.selectOptions(within(dialog).getByLabelText('Единица дозы'), 'кг/га');
    await userEvent.type(within(dialog).getByLabelText('Дата обработки'), '02.06.2026');
    fireEvent.input(within(dialog).getByLabelText('Время обработки'), { target: { value: '09:30' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Записать обработку' }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({
      substanceId: '9e1f3a5b-7c9d-4e0f-a2b4-c6d8e0f2a4b6',
      dose: '1.500',
      doseUnit: 'кг/га',
      appliedAt: new Date('2026-06-02T09:30:00').toISOString().replace('.000Z', 'Z'),
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toastText('polite')).toContain('Обработка записана');
  });

  it('an edit keeps the recorded instant when date and time are unchanged; a closed window (403) says until when', async () => {
    let body: Record<string, unknown> | null = null;
    const until = future();
    server.use(
      dictionaries(),
      contractResponse('listFieldTreatments', { body: pageOf([treatment({ editableUntil: until })]) }),
      contractResponse('updateTreatment', { status: 403, onRequest: async (r) => void (body = await r.json()) }),
    );
    await open(`/fields/${FIELD_ID}`, 'Участок «Восточный-3»');
    await userEvent.click(await screen.findByRole('button', { name: /^Изменить обработку/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Изменить обработку' });
    await userEvent.clear(within(dialog).getByLabelText('Доза'));
    await userEvent.type(within(dialog).getByLabelText('Доза'), '2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.appliedAt).toBe('2026-06-02T07:00:00Z');
    expect(body!.dose).toBe('2.000');
    await waitFor(() =>
      expect(toastText()).toBe(
        `Изменить обработку можно было до ${formatLocalDateTime('2026-06-03T15:20:00Z', 'ru')}: прошло 24 часа с её записи`,
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('INSPECTOR reads: farm fact, no edit, delete or record buttons', async () => {
    server.use(
      asMe({ roles: ['INSPECTOR'] }),
      dictionaries(),
      contractResponse('listFieldTreatments', { body: pageOf([treatment({ editableUntil: future() })]) }),
    );
    await open(`/fields/${FIELD_ID}`, 'Участок «Восточный-3»');
    await screen.findAllByRole('row');
    expect(screen.getByText('Хозяйство')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Изменить|Удалить|Записать обработку/ })).toBeNull();
  });

  it('edits the field in a dialog (PUT with the whole input)', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(dictionaries(), contractResponse('updateField', { onRequest: async (r) => void (body = await r.json()) }));
    await open(`/fields/${FIELD_ID}`, 'Участок «Восточный-3»');
    await userEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog', { name: 'Изменить поле' });
    expect(within(dialog).getByLabelText('Площадь, га')).toHaveValue('124,50');
    await userEvent.clear(within(dialog).getByLabelText('Название'));
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Восточный');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ name: 'Восточный', areaHa: '124.50', regionCode: '23', geometry: field().geometry });
  });

  it('deletes after confirmation and returns to the list', async () => {
    let deleted = false;
    server.use(dictionaries(), contractResponse('deleteField', { onRequest: () => void (deleted = true) }));
    await open(`/fields/${FIELD_ID}`, 'Участок «Восточный-3»');
    await userEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить поле' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(location.pathname).toBe('/fields'));
    expect(deleted).toBe(true);
  });

  it('404: the field is not there — link back to the list', async () => {
    server.use(dictionaries(), contractResponse('getField', { status: 404 }));
    await open(`/fields/${FIELD_ID}`, 'Поле');
    expect(await screen.findByText('Поля нет или оно вам недоступно.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'К списку полей' })).toHaveAttribute('href', '/fields');
  });

  it('a list 400 offers «Сбросить фильтры»; a page past the end goes to the last page', async () => {
    server.use(
      dictionaries(),
      contractResponse('listFields', {
        status: 400,
        body: problem(400, 'VALIDATION', { errors: { q: ['validation.maxLength'] } }),
        once: true,
      }),
    );
    await open('/fields?q=x', 'Поля');
    expect(await screen.findByText('Список нельзя показать с такими фильтрами.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));
    await waitFor(() => expect(location.search).toBe(''));
    expect(await screen.findByRole('link', { name: 'Участок «Восточный-3»' })).toBeInTheDocument();

    server.use(
      contractResponse('listFields', { body: pageOf([], 25, 9), once: true }),
    );
    await router.goto('/fields?page=9');
    await waitFor(() => expect(new URLSearchParams(location.search).get('page')).toBe('2'));
    expect(screen.queryByText('Полей пока нет.')).toBeNull();
  });

  it('a .geojson file is read into the outline field, pretty-printed', async () => {
    server.use(dictionaries());
    await open('/fields/new', 'Новое поле');
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [39, 45],
          [39.1, 45],
          [39.1, 45.1],
          [39, 45],
        ],
      ],
    };
    const file = new File([JSON.stringify({ type: 'Feature', properties: {}, geometry: polygon })], 'north.geojson', {
      type: 'application/geo+json',
    });
    await userEvent.upload(await screen.findByLabelText('Файл контура'), file);
    const outline = screen.getByLabelText('Контур, GeoJSON') as HTMLTextAreaElement;
    await waitFor(() => expect(outline.value).toContain('"type": "Polygon"'));
    expect(outline.value).toContain('[39, 45]');
    expect(JSON.parse(outline.value)).toEqual(polygon);
    expect(document.querySelector('.at-file__size')!.textContent).toMatch(/^\d+ Б$/);
    const hint = document.getElementById(outline.getAttribute('aria-describedby')!.split(' ')[0]!)!;
    expect(hint).toHaveTextContent('GeoJSON (.geojson) с контуром Polygon, до 1 МБ');
  });

  it('a focused «Изменить» that disappears hands the focus to «Записать обработку»', async () => {
    server.use(
      dictionaries(),
      contractResponse('listFieldTreatments', { body: pageOf([treatment({ editableUntil: future() })]), once: true }),
      contractResponse('listFieldTreatments', { body: pageOf([treatment()]) }),
      contractResponse('updateTreatment', { status: 403 }),
    );
    await open(`/fields/${FIELD_ID}`, 'Участок «Восточный-3»');
    await userEvent.click(await screen.findByRole('button', { name: /^Изменить обработку/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Изменить обработку' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Изменить обработку/ })).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Записать обработку' })).toHaveFocus());
  });
});
