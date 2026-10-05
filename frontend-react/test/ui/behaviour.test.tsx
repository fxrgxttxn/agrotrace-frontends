import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import {
  Button,
  Combobox,
  DateInput,
  Dialog,
  Field,
  initials,
  pageWindow,
  Table,
  Tabs,
  TOAST_HIDE_MS,
  ToastProvider,
  useToast,
  type ComboOption,
  type DateError,
  type SortState,
} from '../../src/ui';
import { t } from '../../src/app/i18n';

describe('at-date (R70)', () => {
  function Harness({ min, max }: { min?: string; max?: string }) {
    const [iso, setIso] = useState<string | null>('2026-08-14');
    const [err, setErr] = useState<DateError | null>(null);
    return (
      <>
        <Field id="d" label="Дата уборки" error={err ? t(err) : null}>
          <DateInput value={iso} onChange={setIso} onValidate={setErr} min={min} max={max} />
        </Field>
        <output>{iso ?? 'null'}</output>
      </>
    );
  }

  it('shows the ISO model as ДД.ММ.ГГГГ, masks typing, parses to ISO', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Дата уборки');
    expect(input).toHaveValue('14.08.2026');
    await userEvent.clear(input);
    await userEvent.type(input, '01092026');
    expect(input).toHaveValue('01.09.2026');
    expect(screen.getByRole('status')).toHaveTextContent('2026-09-01');
  });

  it('an incomplete date is a format error after blur', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Дата уборки');
    await userEvent.clear(input);
    await userEvent.type(input, '3102');
    expect(screen.getByRole('status')).toHaveTextContent('null');
    await userEvent.tab();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Недопустимый формат даты');
  });

  it('a date outside min/max is a range error', async () => {
    render(<Harness max="2026-09-25" />);
    const input = screen.getByLabelText('Дата уборки');
    await userEvent.clear(input);
    await userEvent.type(input, '26092026');
    fireEvent.blur(input);
    expect(input).toHaveAccessibleDescription('Значение вне допустимого диапазона');
  });

  it('a pasted ISO date is converted', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Дата уборки');
    await userEvent.clear(input);
    await userEvent.click(input);
    await userEvent.paste('2026-07-01');
    expect(input).toHaveValue('01.07.2026');
  });

  it('the calendar is a hidden native field out of the tab order; picking returns focus to the text', async () => {
    const { container } = render(<Harness max="2026-09-25" />);
    const native = container.querySelector<HTMLInputElement>('.at-date__native')!;
    expect(native).toHaveAttribute('tabindex', '-1');
    expect(native).toHaveAttribute('max', '2026-09-25');
    native.showPicker = vi.fn();
    await userEvent.click(screen.getByRole('button', { name: 'Открыть календарь' }));
    expect(native.value).toBe('2026-08-14');
    expect(native.showPicker).toHaveBeenCalled();
    fireEvent.change(native, { target: { value: '2026-09-02' } });
    expect(screen.getByLabelText('Дата уборки')).toHaveValue('02.09.2026');
    expect(document.activeElement).toBe(screen.getByLabelText('Дата уборки'));
  });
});

describe('at-combobox', () => {
  const OPTIONS: ComboOption[] = [
    { value: '1', label: 'Пшеница озимая', meta: 'Зерно' },
    { value: '2', label: 'Пшеница яровая', disabled: true },
    { value: '3', label: 'Ячмень' },
  ];

  function Harness({
    onSearch,
    loading = false,
    options = OPTIONS,
  }: {
    onSearch?: (q: string) => void;
    loading?: boolean;
    options?: ComboOption[];
  }) {
    const [q, setQ] = useState('');
    const [sel, setSel] = useState<string | null>(null);
    return (
      <Field id="p" label="Продукт">
        <Combobox
          listLabel="Продукт"
          query={q}
          onQueryChange={setQ}
          onSearch={onSearch}
          options={options}
          loading={loading}
          selected={sel}
          onSelect={(o) => {
            setSel(o.value);
            setQ(o.label);
          }}
        />
      </Field>
    );
  }

  it('↓ opens and moves, skipping disabled options; Enter chooses and closes; focus stays in the field', async () => {
    render(<Harness />);
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
    render(<Harness />);
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
    const onSearch = vi.fn();
    render(<Harness onSearch={onSearch} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'п' } });
    fireEvent.change(input, { target: { value: 'пш' } });
    act(() => vi.advanceTimersByTime(200));
    expect(onSearch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(60));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('пш');
    vi.useRealTimers();
  });

  it('loading and empty states replace the listbox with a status', async () => {
    const { rerender } = render(<Harness loading />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'x' } });
    expect(input).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Поиск');
    rerender(<Harness options={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Ничего не найдено.');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('at-tabs', () => {
  it('roving tabindex, ←/→ wrap, Home/End, selection follows focus', async () => {
    function Harness() {
      const [sel, setSel] = useState('a');
      return (
        <Tabs
          label="Партия"
          tabs={[
            { id: 'a', label: 'История' },
            { id: 'b', label: 'Путь' },
            { id: 'c', label: 'Граф' },
          ]}
          selected={sel}
          onSelect={setSel}
          panel={(id) => `panel ${id}`}
        />
      );
    }
    render(<Harness />);
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
  function Harness({ lightDismiss = false }: { lightDismiss?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Открыть</Button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Запустить отзыв"
          lightDismiss={lightDismiss}
        >
          <label htmlFor="code">Код партии</label>
          <input id="code" />
        </Dialog>
      </>
    );
  }

  it('focuses the first field of the body, Esc closes, focus returns to the opener', async () => {
    const { container } = render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Открыть' });
    await userEvent.click(opener);
    const dialog = container.querySelector('dialog')!;
    expect(dialog).toHaveAttribute('open');
    expect(document.activeElement).toBe(screen.getByLabelText('Код партии'));
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(dialog).not.toHaveAttribute('open');
    expect(document.activeElement).toBe(opener);
  });

  it('a confirmation dialog ignores backdrop clicks; a light-dismiss one closes', async () => {
    const { container, unmount } = render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    const dialog = container.querySelector('dialog')!;
    fireEvent.click(dialog);
    expect(dialog).toHaveAttribute('open');
    unmount();
    const second = render(<Harness lightDismiss />);
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    const d2 = second.container.querySelector('dialog')!;
    fireEvent.click(d2);
    expect(d2).not.toHaveAttribute('open');
  });

  it('the cross closes', async () => {
    const { container } = render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(container.querySelector('dialog')).not.toHaveAttribute('open');
  });

  function Mounted({ elsewhere = false }: { elsewhere?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Открыть</Button>
        <Button>Другое</Button>
        {open && (
          <Dialog open onClose={() => setOpen(false)} title="Фото">
            <label htmlFor="file">Файл</label>
            <input id="file" />
            <Button
              onClick={() => {
                if (elsewhere) screen.getByRole('button', { name: 'Другое' }).focus();
                setOpen(false);
              }}
            >
              Готово
            </Button>
          </Dialog>
        )}
      </>
    );
  }

  it('a dialog removed by Esc or by its action returns the focus to the opener', async () => {
    render(<Mounted />);
    const opener = screen.getByRole('button', { name: 'Открыть' });
    await userEvent.click(opener);
    fireEvent(document.querySelector('dialog')!, new Event('cancel', { cancelable: true }));
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a removed dialog leaves alone a focus its screen already moved out of it', async () => {
    render(<Mounted elsewhere />);
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Другое' }));
  });
});

describe('at-toast', () => {
  function Pusher({ tone }: { tone: 'ok' | 'danger' }) {
    const { push } = useToast();
    return <button onClick={() => push({ tone, text: `тост ${tone}` })}>push {tone}</button>;
  }

  it('errors go to role=alert and stay; others to aria-live=polite and hide after 5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ToastProvider>
        <Pusher tone="ok" />
        <Pusher tone="danger" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('push ok'));
    fireEvent.click(screen.getByText('push danger'));
    const [alert, polite] = document.querySelectorAll('.at-toast-region');
    expect(alert!.textContent).toContain('тост danger');
    expect(polite!.textContent).toContain('тост ok');
    act(() => vi.advanceTimersByTime(TOAST_HIDE_MS + 10));
    expect(polite!.textContent).toBe('');
    expect(alert!.textContent).toContain('тост danger');
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(alert!.textContent).toBe('');
    vi.useRealTimers();
  });
});

describe('at-table', () => {
  const rows = [
    { id: 'a', code: 'AT-1' },
    { id: 'b', code: 'AT-2' },
  ];
  function Harness() {
    const [sort, setSort] = useState<SortState | null>({ field: 'code', dir: 'asc' });
    const [sel, setSel] = useState<Set<string>>(new Set());
    return (
      <MemoryRouter>
        <Table
          cards
          rows={rows}
          rowKey={(r) => r.id}
          sort={sort}
          onSort={setSort}
          sortOptions={[
            { value: 'code,asc', label: 'Код' },
            { value: 'code,desc', label: 'Код, обратно' },
          ]}
          selection={{
            selected: sel,
            onChange: setSel,
            allLabel: 'Выбрать все партии',
            rowLabel: (r) => `Выбрать ${r.code}`,
          }}
          columns={[{ key: 'code', header: 'Партия', sortField: 'code', cell: (r) => r.code }]}
        />
      </MemoryRouter>
    );
  }

  it('sort button toggles aria-sort, the mobile select mirrors it', async () => {
    render(<Harness />);
    const th = screen.getByRole('columnheader', { name: 'Партия' });
    expect(th).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(screen.getByRole('button', { name: 'Партия' }));
    expect(th).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('combobox', { name: 'Сортировка' })).toHaveValue('code,desc');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'code,asc');
    expect(th).toHaveAttribute('aria-sort', 'ascending');
  });

  it('row selection marks the row, the header box is indeterminate, then all', async () => {
    render(<Harness />);
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

describe('Radio (F13)', () => {
  it('the choice is the checked property, not an attribute', async () => {
    const { Radio } = await import('../../src/ui');
    const { container } = render(
      <Radio name="theme" value="system" checked onChange={() => {}}>
        Системная
      </Radio>,
    );
    const input = container.querySelector('input')!;
    expect(input.checked).toBe(true);
    expect(input.hasAttribute('checked')).toBe(false);
  });
});
