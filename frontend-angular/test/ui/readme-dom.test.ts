import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/angular';
import { canonical, canonicalHtml, readmeBlock } from './readme';
import { renderProd, useProductionDom } from './prod-dom';
import { ToastService, UI } from '../../src/app/ui';
import { BarChartComponent } from '../../src/charts/bar-chart';
import { TestBed } from '@angular/core/testing';

useProductionDom();

function dom(template: string, ctx: object = {}): string {
  const f = renderProd(template, undefined, ctx);
  return canonical(f.nativeElement.childNodes);
}

function host(template: string, ctx: object = {}) {
  const f = renderProd(template, undefined, ctx);
  return { f, el: f.nativeElement as HTMLElement };
}

const noop = () => {};

describe('README markup contract: forms', () => {
  it('at-button', () => {
    expect(
      dom(`<button class="at-button" [variant]="'primary'" [size]="'m'" [icon]="'truck'">Отгрузить</button>`),
    ).toBe(canonicalHtml(readmeBlock('Кнопка')));
  });

  it('at-button states: busy, icon-only, disabled', () => {
    expect(
      dom(`<button class="at-button" [variant]="'primary'" [busy]="true">Сохранить</button>
        <button class="at-button" [iconOnly]="true" [icon]="'download'" aria-label="Скачать список"></button>
        <button class="at-button" disabled>Отгрузить</button>`),
    ).toBe(canonicalHtml(readmeBlock('Кнопка', 1)));
  });

  it('at-field with an error', () => {
    expect(
      dom(`<div class="at-field" [fieldId]="'mass'" [label]="'Масса'" [error]="'Обязательное поле'">
        <input class="at-input" /></div>`),
    ).toBe(canonicalHtml(readmeBlock('Поле формы')));
  });

  it('at-field without an error', () => {
    expect(
      dom(`<div class="at-field" [fieldId]="'name'" [label]="'Название'"><input class="at-input" /></div>`),
    ).toBe(canonicalHtml(readmeBlock('Поле формы', 1)));
  });

  it('fieldset group', () => {
    expect(
      dom(`<fieldset class="at-field" [legend]="'Тема'" [direction]="'row'">
        <label class="at-radio" [name]="'theme'" [value]="'system'" [label]="'Системная'"></label>
        <label class="at-radio" [name]="'theme'" [value]="'light'" [label]="'Светлая'"></label>
      </fieldset>`),
    ).toBe(canonicalHtml(readmeBlock('Поле формы', 2)));
  });

  it('text inputs', () => {
    expect(
      dom(`<input class="at-input" id="name" /> <input class="at-input at-mono" id="inn" inputmode="numeric" />
        <textarea class="at-textarea" id="comment"></textarea>`),
    ).toBe(canonicalHtml(readmeBlock('Текстовые поля')));
  });

  it('at-date', () => {
    expect(dom(`<div class="at-date" [id]="'harvestedAt'" [value]="''"></div>`)).toBe(
      canonicalHtml(readmeBlock('Дата')),
    );
  });

  it('at-input-group', () => {
    expect(
      dom(
        `<div class="at-input-group" [suffix]="'кг'"><input class="at-input" id="mass" inputmode="decimal" /></div>`,
      ),
    ).toBe(canonicalHtml(readmeBlock('Поле с единицей')));
  });

  it('at-select', () => {
    expect(dom(`<select class="at-select" id="category"><option>Зерно</option></select>`)).toBe(
      canonicalHtml(readmeBlock('Список')),
    );
  });

  it('at-combobox (open after «Пше», second option highlighted, first selected, third disabled)', () => {
    const { f, el } = host(
      `<div class="at-combobox" [id]="'product'" [listLabel]="'Продукт'" [query]="'Пше'" [options]="options" [selected]="'w'"></div>`,
      {
        options: [
          { value: 'w', label: 'Пшеница озимая', meta: 'Зерно' },
          { value: 's', label: 'Пшеница яровая' },
          { value: 'x', label: '…', disabled: true },
        ],
      },
    );
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    f.detectChanges();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    f.detectChanges();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    f.detectChanges();
    expect(canonical(el.childNodes)).toBe(canonicalHtml(readmeBlock('Поиск с подсказками')));
  });

  it('at-combobox states: loading, nothing found, closed without options', () => {
    const { f, el } = host(
      `<div class="at-combobox" [id]="'lab'" [listLabel]="'Лаборатория'" [query]="'аг'" [options]="[]" [loading]="true"></div>
       <div class="at-combobox" [id]="'org'" [listLabel]="'Организация'" [query]="'zz'" [options]="[]"></div>
       <div class="at-combobox" [id]="'region'" [listLabel]="'Регион'" [query]="''" [options]="[]"></div>`,
    );
    fireEvent.keyDown(screen.getAllByRole('combobox')[0]!, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getAllByRole('combobox')[1]!, { key: 'ArrowDown' });
    f.detectChanges();
    expect(canonical(el.childNodes)).toBe(canonicalHtml(readmeBlock('Поиск с подсказками', 1)));
  });

  it('at-combobox: open before the first query — empty status, never hidden', () => {
    const { f, el } = host(
      `<div class="at-combobox" [id]="'r'" [listLabel]="'Регион'" [query]="''" [options]="[]"></div>`,
    );
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    f.detectChanges();
    const status = el.querySelector('[role="status"]')!;
    expect([...status.childNodes].filter((n) => n.nodeType !== Node.COMMENT_NODE)).toHaveLength(0);
    expect(status.hasAttribute('hidden')).toBe(false);
  });

  it('at-combobox closed with options: hidden listbox, no active descendant', () => {
    const { el } = host(
      `<div class="at-combobox" [id]="'p'" [listLabel]="'Продукт'" [query]="''" [options]="[{ value: 'a', label: 'Пшеница' }]"></div>`,
    );
    const list = el.querySelector('ul.at-combobox__list')!;
    expect(list).toHaveAttribute('role', 'listbox');
    expect(list).toHaveAttribute('id', 'p-list');
    expect(list).toHaveAttribute('hidden');
    const input = el.querySelector('input')!;
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('at-check and at-radio', () => {
    expect(
      dom(`<label class="at-check" [label]="'Email'"></label>
        <label class="at-radio" [name]="'decision'" [value]="'APPROVE'" [label]="'Допустить'"></label>`),
    ).toBe(canonicalHtml(readmeBlock('Флажок')));
  });

  it('at-switch', () => {
    expect(dom(`<button class="at-switch" [checked]="true">Уведомления в Telegram</button>`)).toBe(
      canonicalHtml(readmeBlock('Выключатель')),
    );
  });

  it('at-file with an image preview while uploading', () => {
    expect(
      dom(
        `<div class="at-field" [fileId]="'proto'" [label]="'Протокол анализа'" [accept]="'application/pdf,image/*'"
           [hint]="'PDF, JPG или PNG до 10 МБ'" [files]="files"></div>`,
        {
          files: [{ key: '1', name: 'protokol.pdf', sizeText: '1,2 МБ', previewUrl: 'blob:…', progress: 64 }],
        },
      ),
    ).toBe(canonicalHtml(readmeBlock('Файл')));
  });

  it('at-file with an error, a PDF without preview, a file dragged over, no hint', () => {
    const { f, el } = host(
      `<div class="at-field" [fileId]="'proto'" [label]="'Протокол анализа'" [accept]="'application/pdf'"
         [error]="'Файл слишком большой'" [files]="files"></div>`,
      {
        files: [
          { key: '1', name: 'protokol.pdf', sizeText: 'Файл слишком большой', kind: 'PDF', error: true },
        ],
      },
    );
    fireEvent.dragEnter(el.querySelector('.at-file')!);
    f.detectChanges();
    expect(canonical(el.childNodes)).toBe(canonicalHtml(readmeBlock('Файл', 1)));
  });

  it('at-file keeps data-dragover while the pointer moves over nested elements', () => {
    const { f, el } = host(`<div class="at-field" [fileId]="'f'" [label]="'Файл'" [files]="[]"></div>`);
    const zone = el.querySelector('.at-file')!;
    const step = (fn: () => void) => {
      fn();
      f.detectChanges();
    };
    step(() => fireEvent.dragEnter(zone));
    step(() => fireEvent.dragEnter(zone.querySelector('.at-file__action')!));
    step(() => fireEvent.dragLeave(zone));
    expect(zone).toHaveAttribute('data-dragover');
    step(() => fireEvent.dragLeave(zone.querySelector('.at-file__action')!));
    expect(zone).not.toHaveAttribute('data-dragover');
    step(() => fireEvent.dragEnter(zone));
    step(() => fireEvent.drop(zone, { dataTransfer: { files: [] } }));
    expect(zone).not.toHaveAttribute('data-dragover');
  });

  it('at-spinner', () => {
    expect(dom(`<span class="at-spinner"></span>`)).toBe(canonicalHtml(readmeBlock('Индикатор')));
  });
});

describe('README markup contract: data and feedback', () => {
  it('at-chip (status and tone)', () => {
    expect(
      dom(`<span class="at-chip" [status]="'Approved'"></span>
        <span class="at-chip" [tone]="'move'">Отправлена</span>`),
    ).toBe(canonicalHtml(readmeBlock('Статус')));
  });

  it('at-card', () => {
    expect(
      dom(`<article class="at-card">
        <header class="at-card__header" [cardTitle]="'…'">…</header>
        <div class="at-card__body"><dl class="at-card__facts" [facts]="[{ term: 'Масса', value: '12 480,000 кг' }]"></dl></div>
        <footer class="at-card__footer">…кнопки…</footer>
      </article>`),
    ).toBe(canonicalHtml(readmeBlock('Карточка').replace(/(<\/div>)\s*…\s*(<\/dl>)/, '$1$2')));
  });

  const rows = [
    { id: '1', code: 'AT-2026-000123', product: 'Пшеница озимая', status: 'Approved', mass: '12 480,000' },
  ];
  const TABLE = `
    <div class="at-table-mobilebar" [table]="t" [sortOptions]="sortOptions"></div>
    <div class="at-table-wrap" #t="atTable" [cards]="true" [rows]="rows" [rowKey]="rowKey" [sort]="sort" [selection]="selection">
      <ng-template [atColumn]="'code'" [header]="'Партия'" [primary]="true" [sortField]="'code'" let-r>
        <span class="at-table__primary" [href]="'/batches/…'" [code]="r.code" [sub]="r.product"></span>
      </ng-template>
      <ng-template [atColumn]="'status'" [header]="'Статус'" [status]="true" let-r><span class="at-chip" [status]="r.status"></span></ng-template>
      <ng-template [atColumn]="'mass'" [header]="'Масса, кг'" [numeric]="true" [sortField]="'massKg'" let-r>{{ r.mass }}</ng-template>
      <ng-template atRowActions><button class="at-button" [variant]="'secondary'" [size]="'s'">Отгрузить</button></ng-template>
    </div>`;

  it('at-table with selection, sort, mobile bar and actions', () => {
    expect(
      dom(TABLE, {
        rows,
        rowKey: (r: { id: string }) => r.id,
        sort: { field: 'massKg', dir: 'desc' },
        sortOptions: [
          { value: 'massKg,desc', label: 'Масса, по убыванию' },
          { value: 'code,asc', label: 'Код партии' },
        ],
        selection: {
          selected: new Set(['1']),
          allLabel: 'Выбрать все партии',
          rowLabel: (r: { code: string }) => `Выбрать ${r.code}`,
        },
      }),
    ).toBe(canonicalHtml(readmeBlock('Таблица')));
  });

  it('at-table: the checked state lives on the boxes (properties)', () => {
    const { el } = host(TABLE, {
      rows,
      rowKey: (r: { id: string }) => r.id,
      sort: null,
      sortOptions: undefined,
      selection: { selected: new Set(['1']), allLabel: 'Все', rowLabel: () => 'Строка' },
    });
    const boxes = el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect([...boxes].map((b) => b.checked)).toEqual([true, true, true]);
  });

  it('at-table mobile sort while unsorted: a disabled placeholder with an empty value, selected', () => {
    const { el } = host(
      `<div class="at-table-mobilebar" [table]="t" [sortOptions]="[{ value: 'massKg,desc', label: 'Масса, по убыванию' }]"></div>
       <div class="at-table-wrap" #t="atTable" [cards]="true" [rows]="rows" [rowKey]="rowKey" [sort]="null">
         <ng-template [atColumn]="'mass'" [header]="'Масса, кг'" [numeric]="true" [sortField]="'massKg'" let-r>{{ r.mass }}</ng-template>
       </div>`,
      { rows, rowKey: (r: { id: string }) => r.id },
    );
    const label = el.querySelector('.at-table-mobilebar__sort')!;
    expect(canonical([label])).toBe(canonicalHtml(readmeBlock('Таблица', 1)));
    expect(label.querySelector('select')).toHaveValue('');
  });

  it('at-pagination (first, last, current ± 1)', () => {
    expect(
      dom(`<nav class="at-pagination" [page]="1" [size]="20" [total]="248" [hrefFor]="hrefFor"></nav>`, {
        hrefFor: (p: number) => `/batches?page=${p}`,
      }),
    ).toBe(canonicalHtml(readmeBlock('Пагинация')));
  });

  it('at-pagination without URLs (pages of a list inside a card: buttons, its own name)', () => {
    expect(
      dom(
        `<nav class="at-pagination" [page]="2" [size]="200" [total]="450" [label]="'Страницы отклонённых строк'" (pageChange)="noop()"></nav>`,
        { noop: () => undefined },
      ),
    ).toBe(canonicalHtml(readmeBlock('Пагинация', 1)));
  });

  it('at-tabs', () => {
    expect(
      dom(
        `<div class="at-tabs" [label]="'Партия AT-2026-000123'" [tabs]="tabs" [selected]="'history'">
           <ng-template [atTabPanel]="'history'">…</ng-template>
           <ng-template [atTabPanel]="'tests'">…</ng-template>
         </div>`,
        {
          tabs: [
            { id: 'history', label: 'История' },
            { id: 'tests', label: 'Анализы', count: 3 },
          ],
        },
      ),
    ).toBe(canonicalHtml(readmeBlock('Вкладки')));
  });

  it('at-dialog (confirmation, opened: focus on the repeat field, danger disabled)', async () => {
    const { el } =
      host(`<dialog class="at-dialog" [open]="true" [dialogTitle]="'Запустить отзыв'" [titleId]="'recall-title'">
        <div class="at-field" [fieldId]="'recall-code'" [label]="'Код партии'">
          <input class="at-input at-mono" autocomplete="off" />
        </div>
        <div class="at-dialog__actions">
          <button class="at-button" [variant]="'ghost'">Отмена</button>
          <button class="at-button" [variant]="'danger'" disabled>Запустить отзыв</button>
        </div>
      </dialog>`);
    await Promise.resolve();
    const dialog = el.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('Код партии'));
    dialog.removeAttribute('open');
    expect(canonical([dialog])).toBe(canonicalHtml(readmeBlock('Диалог')));
  });

  it('at-dialog without a focusable body: the title takes the focus with tabindex="-1"', async () => {
    host(`<dialog class="at-dialog" [open]="true" [dialogTitle]="'Просмотр'">Текст</dialog>`);
    await Promise.resolve();
    const title = screen.getByRole('heading', { name: 'Просмотр', hidden: true });
    expect(title).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(title);
  });

  it('at-toast regions', () => {
    const f = renderProd(`<div class="at-toasts"></div>`);
    TestBed.inject(ToastService).push({
      tone: 'ok',
      text: 'Партия AT-2026-000123 отгружена',
      detail: '…вторая строка при необходимости…',
    });
    f.detectChanges();
    expect(canonical(f.nativeElement.childNodes)).toBe(canonicalHtml(readmeBlock('Уведомления `at-toast`')));
  });

  it('at-stepper', () => {
    expect(
      dom(
        `<ol class="at-stepper" [label]="'Переработка'" [steps]="['Входы', 'Выходы', 'Проверка баланса']" [current]="1"></ol>`,
      ),
    ).toBe(canonicalHtml(readmeBlock('Шаги')));
  });

  it('at-timeline', () => {
    expect(
      dom(
        `<ol class="at-timeline" [items]="items">
           <ng-template #meta let-item><span class="at-avatar" data-size="s">…</span>{{ item.meta }}</ng-template>
         </ol>`,
        {
          items: [
            {
              key: '1',
              at: '2026-08-19T11:05',
              atText: '19.08.2026, 11:05',
              title: 'Допущена',
              tone: 'ok',
              meta: 'Мария Соколова, ФГБУ «Липецкая МВЛ»',
            },
          ],
        },
      ),
    ).toBe(canonicalHtml(readmeBlock('История')));
  });

  it('at-empty with an inlined illustration', () => {
    const { el } = host(`<div class="at-empty" [art]="'empty-batches'" [text]="'Партий пока нет.'">
        <button class="at-button" [variant]="'primary'">Зарегистрировать партию</button></div>`);
    const art = el.querySelector('svg.at-empty__art')!;
    const paths = art.querySelectorAll('path');
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]!.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(paths[0]!.getAttribute('style')).toMatch(/fill: var\(--c-/);
    art.replaceChildren(document.createTextNode('…illustrations/empty-batches.svg…'));
    expect(canonical(el.childNodes)).toBe(canonicalHtml(readmeBlock('Пустое состояние')));
  });

  it('at-skeleton', () => {
    expect(
      dom(
        `<span class="at-skeleton" [width]="'40%'"></span> <span class="at-skeleton" [shape]="'block'"></span>`,
      ),
    ).toBe(canonicalHtml(readmeBlock('Загрузка')));
  });

  it('at-avatar', () => {
    expect(
      dom(`<span class="at-avatar" [name]="'Иван Петров'" [src]="'…'"></span>
        <span class="at-avatar" [name]="'Иван Петров'"></span>
        <span class="at-avatar" [name]="'КФХ Петров'" [src]="'…'" [size]="'l'" [shape]="'square'"></span>`),
    ).toBe(canonicalHtml(readmeBlock('Аватар')));
  });

  it('at-metric', () => {
    const { el } = host(
      `<div class="at-metric" [label]="'Масса на складе'" [value]="'212,4'" [unit]="'т'" [spark]="[1, 3, 2, 5]"></div>`,
    );
    const svg = el.querySelector('.at-metric__spark svg')!;
    expect(svg.querySelector('polyline')?.getAttribute('stroke')).toBe('currentColor');
    svg.replaceChildren(document.createTextNode('…stroke="currentColor"…'));
    expect(canonical(el.childNodes)).toBe(canonicalHtml(readmeBlock('Показатель')));
  });

  it('at-progress', () => {
    expect(
      dom(
        `<div class="at-progress" [progressId]="'recall-progress'" [label]="'Подтверждено'" [value]="7" [max]="12"></div>`,
      ),
    ).toBe(canonicalHtml(readmeBlock('Прогресс')));
  });

  it('at-chart in its card (canvas summary, collapsed table view)', () => {
    const f = renderProd(
      `<article class="at-card">
        <header class="at-card__header" [cardTitle]="'Доля брака по продуктам'"></header>
        <div class="at-card__body">
          <div class="at-chart" [bars]="bars" [title]="'Доля брака по продуктам'">
            <div class="at-table-wrap" [cards]="true" [caption]="'Доля брака по продуктам'" [rows]="rows" [rowKey]="rowKey">
              <ng-template [atColumn]="'name'" [header]="'Продукт'" [primary]="true" let-r>{{ r.name }}</ng-template>
              <ng-template [atColumn]="'tested'" [header]="'Проверено'" [numeric]="true" let-r>{{ r.tested }}</ng-template>
              <ng-template [atColumn]="'failed'" [header]="'С превышением'" [numeric]="true" let-r>{{ r.failed }}</ng-template>
              <ng-template [atColumn]="'share'" [header]="'Доля брака, %'" [numeric]="true" let-r>{{ r.share }}</ng-template>
            </div>
          </div>
        </div>
      </article>`,
      [...UI, BarChartComponent],
      {
        bars: [
          { key: 'w', label: 'Пшеница озимая', value: 12.5, display: '12,50%' },
          { key: 'b', label: 'Ячмень', value: 0, display: '0,00%' },
        ],
        rows: [{ name: 'Пшеница озимая', tested: 8, failed: 1, share: '12,50' }],
        rowKey: (r: { name: string }) => r.name,
      },
    );
    expect(canonical(f.nativeElement.childNodes)).toBe(canonicalHtml(readmeBlock('График')));
  });
});

describe('README markup contract: page', () => {
  it('at-page header (title with tabindex="-1", actions)', () => {
    const { el } = host(`<div class="at-page__header" [pageTitle]="'Партии'">
        <div class="at-page__actions"><a class="at-button" [variant]="'primary'" [to]="'/batches/new'">Зарегистрировать партию</a></div>
      </div>`);
    const header = readmeBlock('Страница').match(
      /<div class="at-page__header">[\s\S]*?<\/div>\n {2}<\/div>/,
    )![0];
    expect(canonical([el.querySelector('.at-page__header')!])).toBe(canonicalHtml(header));
  });
});

void noop;
