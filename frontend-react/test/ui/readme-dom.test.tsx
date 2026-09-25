import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  Avatar,
  Button,
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
  FileField,
  Input,
  InputGroup,
  Metric,
  Pagination,
  Progress,
  Radio,
  Select,
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
import { canonical, canonicalHtml, expandIcons, readmeBlock } from './readme';
import { useEffect } from 'react';

// Review Focus 1: every wrapper renders exactly the README markup (classes, attributes, ARIA). The README examples
// are parsed from packages/design-system/README.md itself; only its shorthands («…#i-close…», «…») are expanded.

function dom(ui: ReactNode): string {
  const { container } = render(<MemoryRouter>{ui}</MemoryRouter>);
  return canonical(container.childNodes);
}

const noop = () => {};

describe('README markup contract', () => {
  it('at-button', () => {
    expect(
      dom(
        <Button variant="primary" size="m" icon="truck">
          Отгрузить
        </Button>,
      ),
    ).toBe(canonicalHtml(readmeBlock('Кнопка')));
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

  it('at-combobox (open, second option highlighted, first selected, third disabled)', () => {
    const options = [
      { value: 'w', label: 'Пшеница озимая', meta: 'Зерно' },
      { value: 's', label: 'Пшеница яровая' },
      { value: 'x', label: '…', disabled: true },
    ];
    const { container } = render(
      <Combobox
        id="product"
        listLabel="Продукт"
        query=""
        onQueryChange={noop}
        options={options}
        selected="w"
        onSelect={noop}
      />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // open
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // first
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // second
    // With an empty query nothing is marked (the <mark> case is the next test); every option label is a <span>
    // (the README abbreviates the disabled one to «…»).
    const expected = canonicalHtml(readmeBlock('Поиск с подсказками'))
      .replace(/\n( +)<mark>\n +"Пше"\n +"ница яровая"/, '\n$1"Пшеница яровая"')
      .replace(/(id="product-opt-3" role="option">\n)( +)"…"/, '$1$2<span>\n$2  "…"');
    expect(canonical(container.childNodes)).toBe(expected);
  });

  it('at-combobox marks the match', () => {
    const { container } = render(
      <Combobox
        id="p"
        listLabel="Продукт"
        query="пше"
        onQueryChange={noop}
        options={[{ value: 's', label: 'Пшеница яровая' }]}
        onSelect={noop}
      />,
    );
    expect(container.querySelector('li span')?.innerHTML).toBe('<mark>Пше</mark>ница яровая');
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

  it('at-file with an uploading PDF-less image preview', () => {
    const got = dom(
      <FileField
        id="proto"
        label="Протокол анализа"
        accept="application/pdf,image/*"
        hint="PDF, JPG или PNG до 10 МБ"
        files={[{ key: '1', name: 'protokol.pdf', sizeText: '1,2 МБ', previewUrl: 'blob:…', progress: 64 }]}
        onFiles={noop}
        onRemove={noop}
      />,
    );
    // The README input has no id; ours has one so the page can focus it (and a label points at the zone).
    expect(got.replace(' id="proto"', '')).toBe(canonicalHtml(readmeBlock('Файл')));
  });

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
      // README «…» after the fact = more facts of the same shape.
    ).toBe(canonicalHtml(readmeBlock('Карточка').replace(/(<\/div>)\s*…\s*(<\/dl>)/, '$1$2')));
  });

  it('at-table with selection, sort, mobile bar and actions', () => {
    const rows = [
      { id: '1', code: 'AT-2026-000123', product: 'Пшеница озимая', status: 'Approved', mass: '12 480,000' },
    ];
    type Row = (typeof rows)[number];
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
    // Sort values follow the contract's `sort=field,dir` (README: «значение то же, что у сортировки в URL»).
    const expected = canonicalHtml(
      readmeBlock('Таблица')
        .replace(/massKg:desc/, 'massKg,desc')
        .replace(/code:asc/, 'code,asc'),
    );
    expect(got).toBe(expected);
  });

  it('at-pagination', () => {
    const got = dom(<Pagination page={1} size={20} total={248} hrefFor={(p) => `/?page=${p}`} />);
    // README abbreviates the page list (1, 2, …); the last page (13) follows the gap.
    const expected = canonicalHtml(
      expandIcons(readmeBlock('Пагинация'), null)
        .replace(/href="\?page=/g, 'href="/?page=')
        .replace(
          '<li><span class="at-pagination__gap" aria-hidden="true">…</span></li>',
          '<li><span class="at-pagination__gap" aria-hidden="true">…</span></li><li><a class="at-pagination__item" href="/?page=13">13</a></li>',
        ),
    );
    expect(got).toBe(expected);
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
    // Inactive panels are rendered empty (README allows «не выводятся вовсе» for their content).
    expect(got).toBe(canonicalHtml(readmeBlock('Вкладки')).replace(/(hidden=""[^\n]*>)\n\s*"…"/, '$1'));
  });

  it('at-dialog (confirmation, opened)', () => {
    const { baseElement } = render(
      <Dialog
        open
        onClose={noop}
        title="Запустить отзыв"
        titleId="recall-title"
        actions={
          <>
            <Button variant="ghost">Отмена</Button>
            <Button variant="danger">Запустить отзыв</Button>
          </>
        }
      >
        …повтор ключевого параметра (кода партии)…
      </Dialog>,
    );
    const dialog = baseElement.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Запустить отзыв' }));
    dialog.removeAttribute('open');
    // The body has nothing focusable here, so the title takes the initial focus (tabindex="-1", README).
    const expected = canonicalHtml(
      expandIcons(readmeBlock('Диалог'), 'at-button__icon').replace(
        'id="recall-title"',
        'id="recall-title" tabindex="-1"',
      ),
    );
    expect(canonical([dialog])).toBe(expected);
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
    const got = dom(
      <ToastProvider>
        <Push />
      </ToastProvider>,
    );
    const expected = canonicalHtml(
      expandIcons(readmeBlock('Уведомления `at-toast`'), 'at-button__icon').replace(
        /<div class="at-toast-region" role="alert">…ошибки \(data-tone="danger"\)…<\/div>/,
        '<div class="at-toast-region" role="alert"></div>',
      ),
    );
    expect(got).toBe(expected);
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
});
