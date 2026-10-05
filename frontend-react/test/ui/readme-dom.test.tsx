import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import {
  Avatar,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardFacts,
  CardFooter,
  CardHeader,
  Checkbox,
  Chip,
  Combobox,
  DateInput,
  Dialog,
  Empty,
  illustrationMarkup,
  Field,
  FieldSet,
  FileField,
  Input,
  InputGroup,
  Metric,
  Page,
  Pagination,
  Progress,
  Radio,
  Select,
  Skeleton,
  Spinner,
  Stepper,
  Switch,
  Table,
  TablePrimary,
  Tabs,
  Textarea,
  Timeline,
  ToastProvider,
  useToast,
} from '../../src/ui';
import { canonical, canonicalHtml, readmeBlock } from './readme';
import { BarChart } from '../../src/charts/BarChart';

const FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

function dom(ui: ReactNode): string {
  const { container } = render(<MemoryRouter future={FUTURE}>{ui}</MemoryRouter>);
  return canonical(container.childNodes);
}

const noop = () => {};

describe('README markup contract: forms', () => {
  it('at-button', () => {
    expect(
      dom(
        <Button variant="primary" size="m" icon="truck">
          Отгрузить
        </Button>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Кнопка')));
  });

  it('at-button states: busy, icon-only, disabled', () => {
    expect(
      dom(
        <>
          <Button variant="primary" busy>
            Сохранить
          </Button>
          <Button iconOnly icon="download" aria-label="Скачать список" />
          <Button disabled>Отгрузить</Button>
        </>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Кнопка', 1)));
  });

  it('at-field with an error', () => {
    expect(
      dom(
        <Field id="mass" label="Масса" error="Обязательное поле">
          <Input />
        </Field>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Поле формы')));
  });

  it('at-field without an error', () => {
    expect(
      dom(
        <Field id="name" label="Название">
          <Input />
        </Field>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Поле формы', 1)));
  });

  it('fieldset group', () => {
    expect(
      dom(
        <FieldSet legend="Тема" direction="row">
          <Radio name="theme" value="system">
            Системная
          </Radio>
          <Radio name="theme" value="light">
            Светлая
          </Radio>
        </FieldSet>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Поле формы', 2)));
  });

  it('text inputs', () => {
    expect(
      dom(
        <>
          <Input id="name" /> <Input mono id="inn" inputMode="numeric" />
          <Textarea id="comment" />
        </>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Текстовые поля')));
  });

  it('at-date', () => {
    expect(dom(<DateInput id="harvestedAt" value="" onChange={noop} />)).toBe(
      canonicalHtml(readmeBlock('Дата')),
    );
  });

  it('at-input-group', () => {
    expect(dom(<InputGroup id="mass" inputMode="decimal" suffix="кг" />)).toBe(
      canonicalHtml(readmeBlock('Поле с единицей')),
    );
  });

  it('at-select', () => {
    expect(
      dom(
        <Select id="category">
          <option>Зерно</option>
        </Select>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Список')));
  });

  it('at-combobox (open after «Пше», second option highlighted, first selected, third disabled)', () => {
    const options = [
      { value: 'w', label: 'Пшеница озимая', meta: 'Зерно' },
      { value: 's', label: 'Пшеница яровая' },
      { value: 'x', label: '…', disabled: true },
    ];
    const { container } = render(
      <Combobox
        id="product"
        listLabel="Продукт"
        query="Пше"
        onQueryChange={noop}
        options={options}
        selected="w"
        onSelect={noop}
      />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(canonical(container.childNodes)).toBe(canonicalHtml(readmeBlock('Поиск с подсказками')));
  });

  it('at-combobox states: loading, nothing found, closed without options', () => {
    const { container } = render(
      <>
        <Combobox
          id="lab"
          listLabel="Лаборатория"
          query="аг"
          onQueryChange={noop}
          options={[]}
          loading
          onSelect={noop}
        />
        <Combobox
          id="org"
          listLabel="Организация"
          query="zz"
          onQueryChange={noop}
          options={[]}
          onSelect={noop}
        />
        <Combobox id="region" listLabel="Регион" query="" onQueryChange={noop} options={[]} onSelect={noop} />
      </>,
    );
    fireEvent.keyDown(screen.getAllByRole('combobox')[0]!, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getAllByRole('combobox')[1]!, { key: 'ArrowDown' });
    expect(canonical(container.childNodes)).toBe(canonicalHtml(readmeBlock('Поиск с подсказками', 1)));
  });

  it('at-combobox: open before the first query — empty status, never hidden', () => {
    const { container } = render(
      <Combobox id="r" listLabel="Регион" query="" onQueryChange={noop} options={[]} onSelect={noop} />,
    );
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    const status = container.querySelector('[role="status"]')!;
    expect(status.childNodes).toHaveLength(0);
    expect(status.hasAttribute('hidden')).toBe(false);
  });

  it('at-combobox closed with options: hidden listbox, no active descendant', () => {
    const { container } = render(
      <Combobox
        id="p"
        listLabel="Продукт"
        query=""
        onQueryChange={noop}
        options={[{ value: 'a', label: 'Пшеница' }]}
        onSelect={noop}
      />,
    );
    const list = container.querySelector('ul.at-combobox__list')!;
    expect(list).toHaveAttribute('role', 'listbox');
    expect(list).toHaveAttribute('id', 'p-list');
    expect(list).toHaveAttribute('hidden');
    const input = container.querySelector('input')!;
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('at-check and at-radio', () => {
    expect(
      dom(
        <>
          <Checkbox>Email</Checkbox>
          <Radio name="decision" value="APPROVE">
            Допустить
          </Radio>
        </>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Флажок')));
  });

  it('at-switch', () => {
    expect(
      dom(
        <Switch checked onChange={noop}>
          Уведомления в Telegram
        </Switch>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Выключатель')));
  });

  it('at-file with an image preview while uploading', () => {
    expect(
      dom(
        <FileField
          id="proto"
          label="Протокол анализа"
          accept="application/pdf,image/*"
          hint="PDF, JPG или PNG до 10 МБ"
          files={[{ key: '1', name: 'protokol.pdf', sizeText: '1,2 МБ', previewUrl: 'blob:…', progress: 64 }]}
          onFiles={noop}
          onRemove={noop}
        />,
      ),
    ).toBe(canonicalHtml(readmeBlock('Файл')));
  });

  it('at-file with an error, a PDF without preview, a file dragged over, no hint', () => {
    const { container } = render(
      <FileField
        id="proto"
        label="Протокол анализа"
        accept="application/pdf"
        error="Файл слишком большой"
        files={[
          { key: '1', name: 'protokol.pdf', sizeText: 'Файл слишком большой', kind: 'PDF', error: true },
        ]}
        onFiles={noop}
        onRemove={noop}
      />,
    );
    fireEvent.dragEnter(container.querySelector('.at-file')!);
    expect(canonical(container.childNodes)).toBe(canonicalHtml(readmeBlock('Файл', 1)));
  });

  it('at-file keeps data-dragover while the pointer moves over nested elements', () => {
    const { container } = render(<FileField id="f" label="Файл" files={[]} onFiles={noop} onRemove={noop} />);
    const zone = container.querySelector('.at-file')!;
    fireEvent.dragEnter(zone);
    fireEvent.dragEnter(zone.querySelector('.at-file__action')!);
    fireEvent.dragLeave(zone);
    expect(zone).toHaveAttribute('data-dragover');
    fireEvent.dragLeave(zone.querySelector('.at-file__action')!);
    expect(zone).not.toHaveAttribute('data-dragover');
    fireEvent.dragEnter(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [] } });
    expect(zone).not.toHaveAttribute('data-dragover');
  });

  it('at-spinner', () => {
    expect(dom(<Spinner />)).toBe(canonicalHtml(readmeBlock('Индикатор')));
  });
});

describe('README markup contract: data and feedback', () => {
  it('at-chip (status and tone)', () => {
    expect(
      dom(
        <>
          <Chip status="Approved" />
          <Chip tone="move">Отправлена</Chip>
        </>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Статус')));
  });

  it('at-card', () => {
    expect(
      dom(
        <Card>
          <CardHeader title="…">…</CardHeader>
          <CardBody>
            <CardFacts facts={[{ term: 'Масса', value: '12 480,000 кг' }]} />
          </CardBody>
          <CardFooter>…кнопки…</CardFooter>
        </Card>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Карточка').replace(/(<\/div>)\s*…\s*(<\/dl>)/, '$1$2')));
  });

  const rows = [
    { id: '1', code: 'AT-2026-000123', product: 'Пшеница озимая', status: 'Approved', mass: '12 480,000' },
  ];
  type Row = (typeof rows)[number];

  it('at-table with selection, sort, mobile bar and actions', () => {
    const got = dom(
      <Table<Row>
        cards
        rows={rows}
        rowKey={(r) => r.id}
        sort={{ field: 'massKg', dir: 'desc' }}
        onSort={noop}
        sortOptions={[
          { value: 'massKg,desc', label: 'Масса, по убыванию' },
          { value: 'code,asc', label: 'Код партии' },
        ]}
        selection={{
          selected: new Set(['1']),
          onChange: noop,
          allLabel: 'Выбрать все партии',
          rowLabel: (r) => `Выбрать ${r.code}`,
        }}
        columns={[
          {
            key: 'code',
            header: 'Партия',
            primary: true,
            sortField: 'code',
            cell: (r) => <TablePrimary to="/batches/…" code={r.code} sub={r.product} />,
          },
          { key: 'status', header: 'Статус', status: true, cell: (r) => <Chip status={r.status} /> },
          { key: 'mass', header: 'Масса, кг', numeric: true, sortField: 'massKg', cell: (r) => r.mass },
        ]}
        actions={() => (
          <Button variant="secondary" size="s">
            Отгрузить
          </Button>
        )}
      />,
    );
    expect(got).toBe(canonicalHtml(readmeBlock('Таблица')));
  });

  it('at-table mobile sort while unsorted: a disabled placeholder with an empty value, selected', () => {
    const { container } = render(
      <MemoryRouter future={FUTURE}>
        <Table<Row>
          cards
          rows={rows}
          rowKey={(r) => r.id}
          sort={null}
          onSort={noop}
          sortOptions={[{ value: 'massKg,desc', label: 'Масса, по убыванию' }]}
          columns={[
            { key: 'mass', header: 'Масса, кг', numeric: true, sortField: 'massKg', cell: (r) => r.mass },
          ]}
        />
      </MemoryRouter>,
    );
    const label = container.querySelector('.at-table-mobilebar__sort')!;
    expect(canonical([label])).toBe(canonicalHtml(readmeBlock('Таблица', 1)));
    expect(label.querySelector('select')).toHaveValue('');
  });

  it('at-pagination (first, last, current ± 1)', () => {
    expect(dom(<Pagination page={1} size={20} total={248} hrefFor={(p) => `/batches?page=${p}`} />)).toBe(
      canonicalHtml(readmeBlock('Пагинация')),
    );
  });

  it('at-pagination without URLs (pages of a list inside a card: buttons, its own name)', () => {
    expect(
      dom(<Pagination page={2} size={200} total={450} label="Страницы отклонённых строк" onPage={noop} />),
    ).toBe(canonicalHtml(readmeBlock('Пагинация', 1)));
  });

  it('at-tabs', () => {
    const got = dom(
      <Tabs
        label="Партия AT-2026-000123"
        tabs={[
          { id: 'history', label: 'История' },
          { id: 'tests', label: 'Анализы', count: 3 },
        ]}
        selected="history"
        onSelect={noop}
        panel={() => '…'}
      />,
    );
    expect(got).toBe(canonicalHtml(readmeBlock('Вкладки')));
  });

  it('at-dialog (confirmation, opened: focus on the repeat field, danger disabled)', () => {
    const { baseElement } = render(
      <Dialog
        open
        onClose={noop}
        title="Запустить отзыв"
        titleId="recall-title"
        actions={
          <>
            <Button variant="ghost">Отмена</Button>
            <Button variant="danger" disabled>
              Запустить отзыв
            </Button>
          </>
        }
      >
        <Field id="recall-code" label="Код партии">
          <Input mono autoComplete="off" />
        </Field>
      </Dialog>,
    );
    const dialog = baseElement.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('Код партии'));
    dialog.removeAttribute('open');
    expect(canonical([dialog])).toBe(canonicalHtml(readmeBlock('Диалог')));
  });

  it('at-dialog without a focusable body: the title takes the focus with tabindex="-1"', () => {
    render(
      <Dialog open onClose={noop} title="Просмотр">
        Текст
      </Dialog>,
    );
    const title = screen.getByRole('heading', { name: 'Просмотр', hidden: true });
    expect(title).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(title);
  });

  it('at-toast regions', () => {
    function Push() {
      const { push } = useToast();
      useEffect(() => {
        push({
          tone: 'ok',
          text: 'Партия AT-2026-000123 отгружена',
          detail: '…вторая строка при необходимости…',
        });
      }, [push]);
      return null;
    }
    expect(
      dom(
        <ToastProvider>
          <Push />
        </ToastProvider>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Уведомления `at-toast`')));
  });

  it('at-stepper', () => {
    expect(
      dom(<Stepper label="Переработка" steps={['Входы', 'Выходы', 'Проверка баланса']} current={1} />),
    ).toBe(canonicalHtml(readmeBlock('Шаги')));
  });

  it('at-timeline', () => {
    const got = dom(
      <Timeline
        items={[
          {
            key: '1',
            at: '2026-08-19T11:05',
            atText: '19.08.2026, 11:05',
            title: 'Допущена',
            tone: 'ok',
            meta: (
              <>
                <span className="at-avatar" data-size="s">
                  …
                </span>
                Мария Соколова, ФГБУ «Липецкая МВЛ»
              </>
            ),
          },
        ]}
      />,
    );
    expect(got).toBe(canonicalHtml(readmeBlock('История')));
  });

  it('at-empty with an inlined illustration', () => {
    const { container } = render(
      <Empty
        art="empty-batches"
        text="Партий пока нет."
        action={<Button variant="primary">Зарегистрировать партию</Button>}
      />,
    );
    const art = container.querySelector('svg.at-empty__art')!;
    expect(art.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(illustrationMarkup('empty-batches')).toMatch(/style="fill: var\(--c-/);
    art.replaceChildren(document.createTextNode('…illustrations/empty-batches.svg…'));
    expect(canonical(container.childNodes)).toBe(canonicalHtml(readmeBlock('Пустое состояние')));
  });

  it('at-skeleton', () => {
    expect(
      dom(
        <>
          <Skeleton width="40%" />
          <Skeleton shape="block" />
        </>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Загрузка')));
  });

  it('at-avatar', () => {
    expect(
      dom(
        <>
          <Avatar name="Иван Петров" src="…" />
          <Avatar name="Иван Петров" />
          <Avatar name="КФХ Петров" src="…" size="l" shape="square" />
        </>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Аватар')));
  });

  it('at-metric', () => {
    const { container } = render(
      <Metric label="Масса на складе" value="212,4" unit="т" spark={[1, 3, 2, 5]} />,
    );
    const svg = container.querySelector('.at-metric__spark svg')!;
    expect(svg.querySelector('polyline')?.getAttribute('stroke')).toBe('currentColor');
    svg.replaceChildren(document.createTextNode('…stroke="currentColor"…'));
    expect(canonical(container.childNodes)).toBe(canonicalHtml(readmeBlock('Показатель')));
  });

  it('at-progress', () => {
    expect(dom(<Progress id="recall-progress" label="Подтверждено" value={7} max={12} />)).toBe(
      canonicalHtml(readmeBlock('Прогресс')),
    );
  });

  it('at-chart in its card (canvas summary, collapsed table view)', () => {
    type Row = { name: string; tested: number; failed: number; share: string };
    const rows: Row[] = [{ name: 'Пшеница озимая', tested: 8, failed: 1, share: '12,50' }];
    const { container } = render(
      <Card>
        <CardHeader title="Доля брака по продуктам" />
        <CardBody>
          <BarChart
            title="Доля брака по продуктам"
            bars={[
              { key: 'w', label: 'Пшеница озимая', value: 12.5, display: '12,50%' },
              { key: 'b', label: 'Ячмень', value: 0, display: '0,00%' },
            ]}
            columns={[
              { key: 'name', header: 'Продукт', primary: true, cell: (r) => r.name },
              { key: 'tested', header: 'Проверено', numeric: true, cell: (r) => String(r.tested) },
              { key: 'failed', header: 'С превышением', numeric: true, cell: (r) => String(r.failed) },
              { key: 'share', header: 'Доля брака, %', numeric: true, cell: (r) => r.share },
            ]}
            rows={rows}
            rowKey={(r) => r.name}
          />
        </CardBody>
      </Card>,
    );
    expect(canonical(container.childNodes)).toBe(canonicalHtml(readmeBlock('График')));
  });
});

describe('README markup contract: page', () => {
  it('at-page header (title with tabindex="-1", actions)', () => {
    const { container } = render(
      <MemoryRouter future={FUTURE}>
        <Page
          title="Партии"
          actions={
            <ButtonLink variant="primary" to="/batches/new">
              Зарегистрировать партию
            </ButtonLink>
          }
        />
      </MemoryRouter>,
    );
    const header = readmeBlock('Страница').match(
      /<div class="at-page__header">[\s\S]*?<\/div>\n {2}<\/div>/,
    )![0];
    expect(canonical([container.querySelector('.at-page__header')!])).toBe(canonicalHtml(header));
  });
});
