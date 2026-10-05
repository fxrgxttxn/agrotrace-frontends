import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { File as NodeFile } from 'node:buffer';
import { fireEvent, screen, waitFor, within } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import { server } from '../setup';
import { contractExample, contractResponse, type Json } from '../msw/fromContract';
import { asMe, dictionaries, pageOf, pathOf, problem, PRODUCTS, REGIONS, toastText } from '../msw/data';
import { renderApp } from '../app/renderApp';

const PLATFORM = {
  id: 'aa000000-0000-4000-8000-000000000001',
  name: 'ООО «АгроТрейс»',
  type: 'PLATFORM',
  logoUrl: null,
};
const asAdmin = () => asMe({ roles: ['ADMIN'], organization: PLATFORM, isOrgAdmin: true });

async function open(path = '/admin/dictionaries/products') {
  const utils = renderApp(path);
  await screen.findByRole('heading', { level: 1, name: 'Справочники' });
  return utils;
}
const csv = (
  text = 'name;category;lossNormPercent\nЯчмень;GRAIN;3.50\n',
  name = 'products.csv',
  type = 'text/csv',
) => new NodeFile([text], name, { type }) as unknown as File;

const UndiciFormData = (
  await new Response('', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).formData()
).constructor as typeof FormData;
beforeEach(() => vi.stubGlobal('FormData', UndiciFormData));
afterEach(() => vi.unstubAllGlobals());

describe('/admin/dictionaries/:name', () => {
  it('a tab per dictionary; a tab changes the route and keeps the focus', async () => {
    server.use(asAdmin(), dictionaries());
    const h = await open();
    expect(screen.getByRole('tab', { name: 'Продукты' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Пшеница озимая')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Норма потерь, %' })).toBeInTheDocument();
    screen.getByRole('tab', { name: 'Продукты' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(pathOf(h.url())).toBe('/admin/dictionaries/substances'));
    expect(await screen.findByText('Хлорпирифос')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Препараты' })).toHaveFocus();
  });

  it('an unknown dictionary is «not found» with a way to the products', async () => {
    server.use(asAdmin());
    await open('/admin/dictionaries/cows');
    expect(screen.getByText('Такого справочника нет.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'К продуктам' })).toHaveAttribute(
      'href',
      '/admin/dictionaries/products',
    );
  });

  it('adds a product: «2,5» is sent as 2.50; a duplicate name is said on its field', async () => {
    let body: unknown = null;
    server.use(
      asAdmin(),
      dictionaries(),
      contractResponse('createDictionaryEntry', {
        status: 400,
        body: problem(400, 'VALIDATION', { errors: { name: ['validation.duplicate'] } }),
        onRequest: async (r) => void (body = await r.json()),
        once: true,
      }),
    );
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    const dialog = screen.getByRole('dialog', { name: 'Новый продукт' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    expect(await within(dialog).findByLabelText('Название')).toHaveAccessibleDescription('Обязательное поле');
    expect(body).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Ячмень яровой');
    await userEvent.selectOptions(within(dialog).getByLabelText('Категория'), 'Зерно');
    await userEvent.type(within(dialog).getByLabelText('Норма потерь, %'), '2,5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    await waitFor(() =>
      expect(body).toEqual({
        name: 'Ячмень яровой',
        category: 'GRAIN',
        lossNormPercent: '2.50',
        mercuryCode: null,
      }),
    );
    expect(await within(dialog).findByLabelText('Название')).toHaveAccessibleDescription(
      'Повторяющееся значение',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(toastText('polite')).toContain('Ячмень яровой — добавлено'));
  });

  it('deleting a region still in use (409 REFERENCE_IN_USE) says what refers to it', async () => {
    server.use(asAdmin(), dictionaries(), contractResponse('deleteDictionaryEntry', { status: 409 }));
    await open('/admin/dictionaries/regions');
    const name = REGIONS[0]!.name;
    await userEvent.click(await screen.findByRole('button', { name: `Удалить ${name}` }));
    const dialog = screen.getByRole('dialog', { name: `Удалить ${name}` });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }));
    expect(
      await within(dialog).findByText(`${name} нельзя удалить: на запись ссылаются организации, поля.`),
    ).toBeInTheDocument();
    expect(toastText()).toBe('');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(toastText()).toContain(`${name} нельзя удалить`));
  });

  it('imports a CSV: the report shows the counts and every rejected row with its column and reason', async () => {
    let sent: unknown = null;
    server.use(
      asAdmin(),
      dictionaries(),
      contractResponse('importDictionary', {
        onRequest: () => void (sent = true),
      }),
    );
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Импорт' }));
    const dialog = screen.getByRole('dialog', { name: 'Импорт: Продукты' });
    expect(within(dialog).getByText(/name;category;lossNormPercent/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Импортировать' })).toBeDisabled();
    await userEvent.upload(within(dialog).getByLabelText('Файл'), csv());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Импортировать' }));
    await waitFor(() => expect(sent).not.toBeNull());
    const report = (await screen.findByRole('heading', { name: 'Отчёт об импорте: Продукты' })).closest(
      'article',
    )!;
    expect(within(report).getByText('Создано').nextElementSibling).toHaveTextContent('12');
    const errors = within(report).getByRole('table', { name: 'Отклонённые строки' });
    const rows = within(errors).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('7')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Норма потерь, %')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Недопустимый формат')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Повторяющееся значение')).toBeInTheDocument();
    await waitFor(() => expect(toastText('polite')).toContain('отклонено строк 2'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Импорт' })).toHaveFocus());
  });

  it('a report of more than 200 errors is read page by page (200 rows each)', async () => {
    const errors = Array.from({ length: 450 }, (_, i) => ({
      row: i + 2,
      column: 'lossNormPercent',
      message: 'validation.format',
    }));
    server.use(
      asAdmin(),
      dictionaries(),
      contractResponse('importDictionary', {
        body: { created: 0, updated: 0, unchanged: 0, errors },
      }),
    );
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Импорт' }));
    const dialog = screen.getByRole('dialog', { name: 'Импорт: Продукты' });
    await userEvent.upload(within(dialog).getByLabelText('Файл'), csv());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Импортировать' }));
    const report = (await screen.findByRole('heading', { name: 'Отчёт об импорте: Продукты' })).closest(
      'article',
    )!;
    const table = within(report).getByRole('table', { name: 'Отклонённые строки' });
    const bodyRows = () => within(table).getAllByRole('row').slice(1);
    expect(bodyRows()).toHaveLength(200);
    expect(within(bodyRows()[0]!).getByText('2')).toBeInTheDocument();
    const pages = within(report).getByRole('navigation', { name: 'Страницы отклонённых строк' });
    expect(within(pages).getByText('1–200 из 450')).toBeInTheDocument();
    await userEvent.click(within(pages).getByRole('button', { name: 'Следующая страница' }));
    expect(await within(pages).findByText('201–400 из 450')).toBeInTheDocument();
    expect(within(bodyRows()[0]!).getByText('202')).toBeInTheDocument();
    await userEvent.click(within(pages).getByRole('button', { name: 'Следующая страница' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(50));
    expect(within(bodyRows()[49]!).getByText('451')).toBeInTheDocument();
    expect(within(pages).getByRole('button', { name: 'Следующая страница' })).toBeDisabled();
    await waitFor(() => expect(within(pages).getByRole('button', { name: '3' })).toHaveFocus());
    expect(within(pages).getByRole('button', { name: '3' })).toHaveAttribute('aria-current', 'page');
  });

  const refusals: [string, Json, string][] = [
    [
      '415 workbook-too-large',
      {
        status: 415,
        body: problem(415, 'UNSUPPORTED_MEDIA_TYPE', {
          params: { allowed: ['text/csv'], reason: 'workbook-too-large' },
        }),
      },
      'Книга Excel слишком большая',
    ],
    [
      '415 not a workbook',
      { status: 415, body: problem(415, 'UNSUPPORTED_MEDIA_TYPE', { params: { allowed: ['text/csv'] } }) },
      'Файл не читается как книга Excel',
    ],
    ['413', { status: 413 }, 'Файл больше 5 МБ — разделите его на части.'],
    [
      '400 header',
      { status: 400, body: problem(400, 'VALIDATION', { errors: { file: ['validation.import.header'] } }) },
      'Первая строка файла должна быть заголовком: name;category;lossNormPercent',
    ],
    [
      '400 encoding',
      { status: 400, body: problem(400, 'VALIDATION', { errors: { file: ['validation.import.format'] } }) },
      'CSV не читается: сохраните его в кодировке UTF-8',
    ],
  ];
  for (const [what, answer, text] of refusals)
    it(`a refused file (${what}) is explained on the file`, async () => {
      server.use(asAdmin(), dictionaries(), contractResponse('importDictionary', answer));
      await open();
      await userEvent.click(screen.getByRole('button', { name: 'Импорт' }));
      const dialog = screen.getByRole('dialog', { name: 'Импорт: Продукты' });
      await userEvent.upload(
        within(dialog).getByLabelText('Файл'),
        csv('x', 'book.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      );
      await userEvent.click(within(dialog).getByRole('button', { name: 'Импортировать' }));
      expect(await within(dialog).findByLabelText('Файл')).toHaveAccessibleDescription(
        expect.stringContaining(text),
      );
    });

  it('a file of another type or over 5 MB is refused before sending', async () => {
    server.use(asAdmin(), dictionaries());
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Импорт' }));
    const dialog = screen.getByRole('dialog', { name: 'Импорт: Продукты' });
    await userEvent.upload(within(dialog).getByLabelText('Файл'), csv('x', 'notes.pdf', 'application/pdf'), {
      applyAccept: false,
    });
    expect(within(dialog).getByLabelText('Файл')).toHaveAccessibleDescription(
      'Этот тип файла не подходит — выберите CSV, XLSX',
    );
    expect(within(dialog).getByRole('button', { name: 'Импортировать' })).toBeDisabled();
  });

  it('uploads a product photo', async () => {
    let sent = false;
    server.use(
      asAdmin(),
      dictionaries(),
      contractResponse('uploadProductImage', { onRequest: () => void (sent = true) }),
    );
    await open();
    const name = PRODUCTS[0]!.name;
    await userEvent.click(await screen.findByRole('button', { name: `Фото ${name}` }));
    const dialog = screen.getByRole('dialog', { name: `Фото: ${name}` });
    await userEvent.upload(
      within(dialog).getByLabelText('Файл'),
      new NodeFile(['img'], 'p.png', { type: 'image/png' }) as unknown as File,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(sent).toBe(true));
    await waitFor(() => expect(toastText('polite')).toContain(`Фото ${name} сохранено`));
  });

  it('Esc in the photo dialog gives the focus back to the row «Фото» button', async () => {
    server.use(asAdmin(), dictionaries());
    await open();
    const name = PRODUCTS[0]!.name;
    const opener = await screen.findByRole('button', { name: `Фото ${name}` });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: `Фото: ${name}` });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
    await new Promise((r) => setTimeout(r, 50));
    expect(opener).toHaveFocus();
  });

  it('«Показывать удалённые» asks with includeDeleted and marks the deleted rows', async () => {
    const seen: URLSearchParams[] = [];
    const gone = {
      ...(contractExample('listDictionary').body as Json).items[0],
      deletedAt: '2026-09-01T00:00:00Z',
    };
    server.use(
      asAdmin(),
      contractResponse('listDictionary', {
        body: pageOf([gone]),
        onRequest: (r) => void seen.push(new URL(r.url).searchParams),
      }),
    );
    await open();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Показывать удалённые' }));
    await waitFor(() => expect(seen.at(-1)!.get('includeDeleted')).toBe('true'));
    expect(await screen.findByText('Удалена')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Изменить ${gone.name}` })).toBeNull();
  });
});
