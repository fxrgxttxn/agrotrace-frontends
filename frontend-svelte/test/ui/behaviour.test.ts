import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { initials, pageWindow, TOAST_HIDE_MS, toasts } from '../../src/lib/ui';
import Behaviour from './Behaviour.svelte';

describe('at-date (R70)', () => {
  it('shows the ISO model as ДД.ММ.ГГГГ, masks typing, parses to ISO', async () => {
    render(Behaviour, { name: 'date' });
    const input = screen.getByLabelText('Дата уборки');
    expect(input).toHaveValue('14.08.2026');
    await userEvent.clear(input);
    await userEvent.type(input, '01092026');
    expect(input).toHaveValue('01.09.2026');
    expect(screen.getByRole('status')).toHaveTextContent('2026-09-01');
  });

  it('an incomplete date is a format error after blur', async () => {
    render(Behaviour, { name: 'date' });
    const input = screen.getByLabelText('Дата уборки');
    await userEvent.clear(input);
    await userEvent.type(input, '3102');
    expect(screen.getByRole('status')).toHaveTextContent('null');
    await userEvent.tab();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Недопустимый формат даты');
  });

  it('a date outside min/max is a range error', async () => {
    render(Behaviour, { name: 'date', max: '2026-09-25' });
    const input = screen.getByLabelText('Дата уборки');
    await userEvent.clear(input);
    await userEvent.type(input, '26092026');
    await fireEvent.blur(input);
    expect(input).toHaveAccessibleDescription('Значение вне допустимого диапазона');
  });

  it('a pasted ISO date is converted', async () => {
    render(Behaviour, { name: 'date' });
    const input = screen.getByLabelText('Дата уборки');
    await userEvent.clear(input);
    await userEvent.click(input);
    await userEvent.paste('2026-07-01');
    expect(input).toHaveValue('01.07.2026');
  });

  it('the calendar is a hidden native field out of the tab order; picking returns focus to the text', async () => {
    const { container } = render(Behaviour, { name: 'date', max: '2026-09-25' });
    const native = container.querySelector<HTMLInputElement>('.at-date__native')!;
    expect(native).toHaveAttribute('tabindex', '-1');
    expect(native).toHaveAttribute('max', '2026-09-25');
    native.showPicker = vi.fn();
    await userEvent.click(screen.getByRole('button', { name: 'Открыть календарь' }));
    expect(native.value).toBe('2026-08-14');
    expect(native.showPicker).toHaveBeenCalled();
    await fireEvent.change(native, { target: { value: '2026-09-02' } });
    expect(screen.getByLabelText('Дата уборки')).toHaveValue('02.09.2026');
    expect(document.activeElement).toBe(screen.getByLabelText('Дата уборки'));
  });
});

describe('at-combobox', () => {
  it('↓ opens and moves, skipping disabled options; Enter chooses and closes; focus stays in the field', async () => {
    render(Behaviour, { name: 'combobox' });
    const input = screen.getByRole('combobox', { name: 'Продукт' });
    input.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', 'p-opt-3');
    await userEvent.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', 'p-opt-1');
    await userEvent.keyboard('{End}');
    expect(input).toHaveAttribute('aria-activedescendant', 'p-opt-3');
    await userEvent.keyboard('{Home}{Enter}');
    expect(input).toHaveValue('Пшеница озимая');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(document.activeElement).toBe(input);
  });

  it('Esc closes without choosing; a click chooses', async () => {
    render(Behaviour, { name: 'combobox' });
    const input = screen.getByRole('combobox');
    input.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Escape}');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveValue('');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.click(screen.getByRole('option', { name: 'Ячмень' }));
    expect(input).toHaveValue('Ячмень');
  });

  it('server search runs 250 ms after the last keystroke', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onsearch = vi.fn();
    render(Behaviour, { name: 'combobox', onsearch });
    const input = screen.getByRole('combobox');
    await fireEvent.input(input, { target: { value: 'п' } });
    await fireEvent.input(input, { target: { value: 'пш' } });
    vi.advanceTimersByTime(200);
    expect(onsearch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(onsearch).toHaveBeenCalledTimes(1);
    expect(onsearch).toHaveBeenCalledWith('пш');
    vi.useRealTimers();
  });

  it('loading and empty states replace the listbox with a status', async () => {
    const { rerender } = render(Behaviour, { name: 'combobox', loading: true });
    const input = screen.getByRole('combobox');
    await fireEvent.input(input, { target: { value: 'x' } });
    expect(input).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Поиск');
    await rerender({ name: 'combobox', loading: false, options: [] });
    expect(screen.getByRole('status')).toHaveTextContent('Ничего не найдено.');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('at-tabs', () => {
  it('roving tabindex, ←/→ wrap, Home/End, selection follows focus', async () => {
    render(Behaviour, { name: 'tabs' });
    const tab = (name: string) => screen.getByRole('tab', { name });
    expect(tab('История')).toHaveAttribute('tabindex', '0');
    expect(tab('Путь')).toHaveAttribute('tabindex', '-1');
    tab('История').focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(tab('Граф')).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(tab('Граф'));
    await userEvent.keyboard('{ArrowRight}');
    expect(tab('История')).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel c');
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tabpanel', { name: 'История' })).toBeVisible();
  });
});

describe('at-dialog', () => {
  it('focuses the first field of the body, Esc closes, focus returns to the opener', async () => {
    const { container } = render(Behaviour, { name: 'dialog' });
    const opener = screen.getByRole('button', { name: 'Открыть' });
    await userEvent.click(opener);
    const dialog = container.querySelector('dialog')!;
    expect(dialog).toHaveAttribute('open');
    expect(document.activeElement).toBe(screen.getByLabelText('Код партии'));
    await fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(dialog).not.toHaveAttribute('open');
    expect(document.activeElement).toBe(opener);
  });

  it('a confirmation dialog ignores backdrop clicks; a light-dismiss one closes', async () => {
    const first = render(Behaviour, { name: 'dialog' });
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    const dialog = first.container.querySelector('dialog')!;
    await fireEvent.click(dialog);
    expect(dialog).toHaveAttribute('open');
    first.unmount();
    const second = render(Behaviour, { name: 'dialog', lightDismiss: true });
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    const d2 = second.container.querySelector('dialog')!;
    await fireEvent.click(d2);
    expect(d2).not.toHaveAttribute('open');
  });

  it('the cross closes', async () => {
    const { container } = render(Behaviour, { name: 'dialog' });
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(container.querySelector('dialog')).not.toHaveAttribute('open');
  });

  it('a dialog removed by Esc or by its action returns the focus to the opener', async () => {
    render(Behaviour, { name: 'dialog-mounted' });
    const opener = screen.getByRole('button', { name: 'Открыть' });
    await userEvent.click(opener);
    await fireEvent(document.querySelector('dialog')!, new Event('cancel', { cancelable: true }));
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a removed dialog leaves alone a focus its screen already moved out of it', async () => {
    render(Behaviour, { name: 'dialog-mounted', elsewhere: true });
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Другое' }));
  });
});

describe('at-toast', () => {
  it('errors go to role=alert and stay; others to aria-live=polite and hide after 5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    toasts.reset();
    render(Behaviour, { name: 'toasts' });
    await fireEvent.click(screen.getByText('push ok'));
    await fireEvent.click(screen.getByText('push danger'));
    const [alert, polite] = document.querySelectorAll('.at-toast-region');
    expect(alert!.textContent).toContain('тост danger');
    expect(polite!.textContent).toContain('тост ok');
    expect(alert!.textContent).toBe('тост danger');
    vi.advanceTimersByTime(TOAST_HIDE_MS + 10);
    await tick();
    expect(polite!.textContent).toBe('');
    expect(alert!.textContent).toContain('тост danger');
    await fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(alert!.textContent).toBe('');
    vi.useRealTimers();
  });
});

describe('at-table', () => {
  it('sort button toggles aria-sort, the mobile select mirrors it', async () => {
    render(Behaviour, { name: 'table' });
    const th = screen.getByRole('columnheader', { name: 'Партия' });
    expect(th).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(screen.getByRole('button', { name: 'Партия' }));
    expect(th).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('combobox', { name: 'Сортировка' })).toHaveValue('code,desc');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'code,asc');
    expect(th).toHaveAttribute('aria-sort', 'ascending');
  });

  it('row selection marks the row, the header box is indeterminate, then all', async () => {
    render(Behaviour, { name: 'table' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Выбрать AT-1' }));
    expect(screen.getByRole('checkbox', { name: 'Выбрать AT-1' }).closest('tr')).toHaveAttribute(
      'data-selected',
    );
    const all = screen.getByRole('checkbox', { name: 'Выбрать все партии' }) as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Выбрать все' }));
    expect(all).toBeChecked();
    expect(all.indeterminate).toBe(false);
    expect(document.querySelectorAll('tr[data-selected]')).toHaveLength(2);
  });
});

describe('helpers', () => {
  it('page window: first, last, current ± 1, gaps', () => {
    expect(pageWindow(1, 13)).toEqual([1, 2, null, 13]);
    expect(pageWindow(7, 13)).toEqual([1, null, 6, 7, 8, null, 13]);
    expect(pageWindow(3, 13)).toEqual([1, 2, 3, 4, null, 13]);
    expect(pageWindow(1, 1)).toEqual([1]);
  });

  it('initials', () => {
    expect(initials('Иван Петров')).toBe('ИП');
    expect(initials('Петров Иван Сергеевич')).toBe('ПИ');
    expect(initials('Admin')).toBe('AD');
    expect(initials('ООО «Кубанский мукомол»')).toBe('ОК');
  });
});

describe('design-system sync', () => {
  it('at-file: the hint carries `<id>-hint` (another field may describe itself with it)', async () => {
    const { default: FileField } = await import('../../src/lib/ui/FileField.svelte');
    const { container } = render(FileField, {
      id: 'outline-file',
      label: 'Файл контура',
      hint: 'GeoJSON (.geojson) с контуром Polygon, до 1 МБ',
      files: [],
      onfiles: () => {},
      onremove: () => {},
    });
    expect(container.querySelector('.at-file__hint')).toHaveAttribute('id', 'outline-file-hint');
  });

  it('at-metric: the second line is the last child of the value, after the unit (README «Показатель»)', async () => {
    const { default: Metric } = await import('../../src/lib/ui/Metric.svelte');
    const { container } = render(Metric, {
      label: 'Задачи отзыва',
      value: '4',
      delta: 'из них просрочено: 1',
    });
    const value = container.querySelector('.at-metric__value')!;
    expect(value.lastElementChild).toHaveClass('at-metric__delta');
    expect(value.lastElementChild).toHaveTextContent('из них просрочено: 1');
  });
});
