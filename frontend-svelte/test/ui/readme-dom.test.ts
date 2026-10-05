import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { illustrationMarkup, toasts } from '../../src/lib/ui';
import { canonical, canonicalHtml, readmeBlock } from './readme';
import ReadmeCase from './ReadmeCase.svelte';

function dom(name: string): string {
  const { container } = render(ReadmeCase, { name });
  return canonical(container.childNodes);
}

describe('README markup contract: forms', () => {
  it('at-button', () => {
    expect(dom('button')).toBe(canonicalHtml(readmeBlock('Кнопка')));
  });

  it('at-button states: busy, icon-only, disabled', () => {
    expect(dom('button-states')).toBe(canonicalHtml(readmeBlock('Кнопка', 1)));
  });

  it('at-field with an error', () => {
    expect(dom('field-error')).toBe(canonicalHtml(readmeBlock('Поле формы')));
  });

  it('at-field without an error', () => {
    expect(dom('field')).toBe(canonicalHtml(readmeBlock('Поле формы', 1)));
  });

  it('fieldset group', () => {
    expect(dom('fieldset')).toBe(canonicalHtml(readmeBlock('Поле формы', 2)));
  });

  it('text inputs', () => {
    expect(dom('inputs')).toBe(canonicalHtml(readmeBlock('Текстовые поля')));
  });

  it('at-date', () => {
    expect(dom('date')).toBe(canonicalHtml(readmeBlock('Дата')));
  });

  it('at-input-group', () => {
    expect(dom('input-group')).toBe(canonicalHtml(readmeBlock('Поле с единицей')));
  });

  it('at-select', () => {
    expect(dom('select')).toBe(canonicalHtml(readmeBlock('Список')));
  });

  it('at-combobox (open after «Пше», second option highlighted, first selected, third disabled)', async () => {
    const { container } = render(ReadmeCase, { name: 'combobox' });
    const input = screen.getByRole('combobox');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(canonical(container.childNodes)).toBe(canonicalHtml(readmeBlock('Поиск с подсказками')));
  });

  it('at-combobox states: loading, nothing found, closed without options', async () => {
    const { container } = render(ReadmeCase, { name: 'combobox-states' });
    await fireEvent.keyDown(screen.getAllByRole('combobox')[0]!, { key: 'ArrowDown' });
    await fireEvent.keyDown(screen.getAllByRole('combobox')[1]!, { key: 'ArrowDown' });
    expect(canonical(container.childNodes)).toBe(canonicalHtml(readmeBlock('Поиск с подсказками', 1)));
  });

  it('at-combobox: open before the first query — empty status, never hidden', async () => {
    const { container } = render(ReadmeCase, { name: 'combobox-empty' });
    await fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    const status = container.querySelector('[role="status"]')!;
    expect([...status.childNodes].filter((n) => n.nodeType !== Node.COMMENT_NODE)).toHaveLength(0);
    expect(status.hasAttribute('hidden')).toBe(false);
    expect(status.matches(':empty')).toBe(true);
  });

  it('at-combobox closed with options: hidden listbox, no active descendant', () => {
    const { container } = render(ReadmeCase, { name: 'combobox-closed' });
    const list = container.querySelector('ul.at-combobox__list')!;
    expect(list).toHaveAttribute('role', 'listbox');
    expect(list).toHaveAttribute('id', 'p-list');
    expect(list).toHaveAttribute('hidden');
    const input = container.querySelector('input')!;
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('at-check and at-radio', () => {
    expect(dom('check')).toBe(canonicalHtml(readmeBlock('Флажок')));
  });

  it('at-switch', () => {
    expect(dom('switch')).toBe(canonicalHtml(readmeBlock('Выключатель')));
  });

  it('at-file with an image preview while uploading', () => {
    expect(dom('file')).toBe(canonicalHtml(readmeBlock('Файл')));
  });

  it('at-file with an error, a PDF without preview, a file dragged over, no hint', async () => {
    const { container } = render(ReadmeCase, { name: 'file-error' });
    await fireEvent.dragEnter(container.querySelector('.at-file')!);
    expect(canonical(container.childNodes)).toBe(canonicalHtml(readmeBlock('Файл', 1)));
  });

  it('at-file keeps data-dragover while the pointer moves over nested elements', async () => {
    const { container } = render(ReadmeCase, { name: 'file-empty' });
    const zone = container.querySelector('.at-file')!;
    await fireEvent.dragEnter(zone);
    await fireEvent.dragEnter(zone.querySelector('.at-file__action')!);
    await fireEvent.dragLeave(zone);
    expect(zone).toHaveAttribute('data-dragover');
    await fireEvent.dragLeave(zone.querySelector('.at-file__action')!);
    expect(zone).not.toHaveAttribute('data-dragover');
    await fireEvent.dragEnter(zone);
    await fireEvent.drop(zone, { dataTransfer: { files: [] } });
    expect(zone).not.toHaveAttribute('data-dragover');
  });

  it('at-spinner', () => {
    expect(dom('spinner')).toBe(canonicalHtml(readmeBlock('Индикатор')));
  });
});

describe('README markup contract: data and feedback', () => {
  it('at-chip (status and tone)', () => {
    expect(dom('chip')).toBe(canonicalHtml(readmeBlock('Статус')));
  });

  it('at-card', () => {
    expect(dom('card')).toBe(
      canonicalHtml(readmeBlock('Карточка').replace(/(<\/div>)\s*…\s*(<\/dl>)/, '$1$2')),
    );
  });

  it('at-table with selection, sort, mobile bar and actions', () => {
    expect(dom('table')).toBe(canonicalHtml(readmeBlock('Таблица')));
  });

  it('at-table mobile sort while unsorted: a disabled placeholder with an empty value, selected', () => {
    const { container } = render(ReadmeCase, { name: 'table-unsorted' });
    const label = container.querySelector('.at-table-mobilebar__sort')!;
    expect(canonical([label])).toBe(canonicalHtml(readmeBlock('Таблица', 1)));
    expect(label.querySelector('select')).toHaveValue('');
  });

  it('at-pagination (first, last, current ± 1)', () => {
    expect(dom('pagination')).toBe(canonicalHtml(readmeBlock('Пагинация')));
  });

  it('at-pagination without URLs (pages of a list inside a card: buttons, its own name)', () => {
    expect(dom('pagination-buttons')).toBe(canonicalHtml(readmeBlock('Пагинация', 1)));
  });

  it('at-tabs', () => {
    expect(dom('tabs')).toBe(canonicalHtml(readmeBlock('Вкладки')));
  });

  it('at-dialog (confirmation, opened: focus on the repeat field, danger disabled)', async () => {
    const { baseElement } = render(ReadmeCase, { name: 'dialog' });
    await tick();
    const dialog = baseElement.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('Код партии'));
    dialog.removeAttribute('open');
    expect(canonical([dialog])).toBe(canonicalHtml(readmeBlock('Диалог')));
  });

  it('at-dialog without a focusable body: the title takes the focus with tabindex="-1"', async () => {
    render(ReadmeCase, { name: 'dialog-plain' });
    await tick();
    const title = screen.getByRole('heading', { name: 'Просмотр', hidden: true });
    expect(title).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(title);
  });

  it('at-toast regions', () => {
    toasts.reset();
    toasts.push({
      tone: 'ok',
      text: 'Партия AT-2026-000123 отгружена',
      detail: '…вторая строка при необходимости…',
    });
    try {
      expect(dom('toasts')).toBe(canonicalHtml(readmeBlock('Уведомления `at-toast`')));
    } finally {
      toasts.reset();
    }
  });

  it('at-stepper', () => {
    expect(dom('stepper')).toBe(canonicalHtml(readmeBlock('Шаги')));
  });

  it('at-timeline', () => {
    expect(dom('timeline')).toBe(canonicalHtml(readmeBlock('История')));
  });

  it('at-empty with an inlined illustration', () => {
    const { container } = render(ReadmeCase, { name: 'empty' });
    const art = container.querySelector('svg.at-empty__art')!;
    const paths = art.querySelectorAll('path');
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]!.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(illustrationMarkup('empty-batches')).toMatch(/style="fill: var\(--c-/);
    art.replaceChildren(document.createTextNode('…illustrations/empty-batches.svg…'));
    expect(canonical(container.childNodes)).toBe(canonicalHtml(readmeBlock('Пустое состояние')));
  });

  it('at-skeleton', () => {
    expect(dom('skeleton')).toBe(canonicalHtml(readmeBlock('Загрузка')));
  });

  it('at-avatar', () => {
    expect(dom('avatar')).toBe(canonicalHtml(readmeBlock('Аватар')));
  });

  it('at-metric', () => {
    const { container } = render(ReadmeCase, { name: 'metric' });
    const svg = container.querySelector('.at-metric__spark svg')!;
    expect(svg.querySelector('polyline')?.getAttribute('stroke')).toBe('currentColor');
    svg.replaceChildren(document.createTextNode('…stroke="currentColor"…'));
    expect(canonical(container.childNodes)).toBe(canonicalHtml(readmeBlock('Показатель')));
  });

  it('at-progress', () => {
    expect(dom('progress')).toBe(canonicalHtml(readmeBlock('Прогресс')));
  });

  it('at-chart in its card (canvas summary, collapsed table view)', () => {
    expect(dom('chart')).toBe(canonicalHtml(readmeBlock('График')));
  });
});

describe('README markup contract: page', () => {
  it('at-page header (title with tabindex="-1", actions)', () => {
    const { container } = render(ReadmeCase, { name: 'page' });
    const header = readmeBlock('Страница').match(
      /<div class="at-page__header">[\s\S]*?<\/div>\n {2}<\/div>/,
    )![0];
    expect(canonical([container.querySelector('.at-page__header')!])).toBe(canonicalHtml(header));
  });
});
