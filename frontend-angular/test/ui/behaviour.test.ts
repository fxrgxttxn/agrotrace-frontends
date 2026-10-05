import { describe, expect, it, vi } from 'vitest';
import { ChangeDetectionStrategy, Component, signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { fireEvent, screen, waitFor } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';
import {
  initials,
  pageWindow,
  TOAST_HIDE_MS,
  ToastService,
  UI,
  type ComboOption,
  type DateError,
  type SortState,
} from '../../src/app/ui';
import { t } from '../../src/app/i18n';

function mount<T>(type: Type<T>) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const f = TestBed.createComponent(type);
  f.autoDetectChanges(true);
  return f;
}

@Component({
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-field" [fieldId]="'d'" [label]="'Дата уборки'" [error]="err() ? t(err()!) : null">
      <div
        class="at-date"
        [value]="iso()"
        [min]="min"
        [max]="max"
        (valueChange)="iso.set($event)"
        (validate)="err.set($event)"
      ></div>
    </div>
    <output>{{ iso() ?? 'null' }}</output>`,
})
class DateHarness {
  protected readonly t = t;
  static max: string | undefined;
  readonly iso = signal<string | null>('2026-08-14');
  readonly err = signal<DateError | null>(null);
  readonly min: string | undefined = undefined;
  readonly max = DateHarness.max;
}

describe('at-date (R70)', () => {
  it('shows the ISO model as ДД.ММ.ГГГГ, masks typing, parses to ISO', async () => {
    DateHarness.max = undefined;
    mount(DateHarness);
    const input = screen.getByLabelText('Дата уборки');
    expect(input).toHaveValue('14.08.2026');
    await userEvent.clear(input);
    await userEvent.type(input, '01092026');
    expect(input).toHaveValue('01.09.2026');
    expect(screen.getByRole('status')).toHaveTextContent('2026-09-01');
  });

  it('an incomplete date is a format error after blur', async () => {
    DateHarness.max = undefined;
    mount(DateHarness);
    const input = screen.getByLabelText('Дата уборки');
    await userEvent.clear(input);
    await userEvent.type(input, '3102');
    expect(screen.getByRole('status')).toHaveTextContent('null');
    await userEvent.tab();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Недопустимый формат даты');
  });

  it('a date outside min/max is a range error', async () => {
    DateHarness.max = '2026-09-25';
    mount(DateHarness);
    const input = screen.getByLabelText('Дата уборки');
    await userEvent.clear(input);
    await userEvent.type(input, '26092026');
    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveAccessibleDescription('Значение вне допустимого диапазона'));
  });

  it('a pasted ISO date is converted', async () => {
    DateHarness.max = undefined;
    mount(DateHarness);
    const input = screen.getByLabelText('Дата уборки');
    await userEvent.clear(input);
    await userEvent.click(input);
    await userEvent.paste('2026-07-01');
    expect(input).toHaveValue('01.07.2026');
  });

  it('the calendar is a hidden native field out of the tab order; picking returns focus to the text', async () => {
    DateHarness.max = '2026-09-25';
    const f = mount(DateHarness);
    const native = (f.nativeElement as HTMLElement).querySelector<HTMLInputElement>('.at-date__native')!;
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

  it('an external model change replaces the text', async () => {
    DateHarness.max = undefined;
    const f = mount(DateHarness);
    f.componentInstance.iso.set('2026-01-05');
    await waitFor(() => expect(screen.getByLabelText('Дата уборки')).toHaveValue('05.01.2026'));
  });
});

const OPTIONS: ComboOption[] = [
  { value: '1', label: 'Пшеница озимая', meta: 'Зерно' },
  { value: '2', label: 'Пшеница яровая', disabled: true },
  { value: '3', label: 'Ячмень' },
];

@Component({
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-field" [fieldId]="'p'" [label]="'Продукт'">
    <div
      class="at-combobox"
      [listLabel]="'Продукт'"
      [query]="q()"
      [options]="options()"
      [loading]="loading()"
      [selected]="sel()"
      (queryChange)="q.set($event)"
      (search)="searched($event)"
      (chosen)="sel.set($event.value); q.set($event.label)"
    ></div>
  </div>`,
})
class ComboHarness {
  static onSearch: (q: string) => void = () => {};
  readonly q = signal('');
  readonly sel = signal<string | null>(null);
  readonly options = signal(OPTIONS);
  readonly loading = signal(false);
  searched(q: string) {
    ComboHarness.onSearch(q);
  }
}

describe('at-combobox', () => {
  it('↓ opens and moves, skipping disabled options; Enter chooses and closes; focus stays in the field', async () => {
    mount(ComboHarness);
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
    mount(ComboHarness);
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
    ComboHarness.onSearch = onSearch;
    mount(ComboHarness);
    const input = screen.getByRole('combobox');
    fireEvent.input(input, { target: { value: 'п' } });
    fireEvent.input(input, { target: { value: 'пш' } });
    vi.advanceTimersByTime(200);
    expect(onSearch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('пш');
    vi.useRealTimers();
    ComboHarness.onSearch = () => {};
  });

  it('loading and empty states replace the listbox with a status', async () => {
    const f = mount(ComboHarness);
    f.componentInstance.loading.set(true);
    const input = screen.getByRole('combobox');
    fireEvent.input(input, { target: { value: 'x' } });
    await waitFor(() => expect(input).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByRole('status')).toHaveTextContent('Поиск');
    f.componentInstance.loading.set(false);
    f.componentInstance.options.set([]);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Ничего не найдено.'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

@Component({
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div
    class="at-tabs"
    [label]="'Партия'"
    [tabs]="tabs"
    [selected]="sel()"
    (select)="sel.set($event)"
  >
    <ng-template [atTabPanel]="'a'">panel a</ng-template>
    <ng-template [atTabPanel]="'b'">panel b</ng-template>
    <ng-template [atTabPanel]="'c'">panel c</ng-template>
  </div>`,
})
class TabsHarness {
  readonly sel = signal('a');
  readonly tabs = [
    { id: 'a', label: 'История' },
    { id: 'b', label: 'Путь' },
    { id: 'c', label: 'Граф' },
  ];
}

describe('at-tabs', () => {
  it('roving tabindex, ←/→ wrap, Home/End, selection follows focus', async () => {
    mount(TabsHarness);
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

@Component({
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button class="at-button" (click)="open.set(true)">Открыть</button>
    <dialog
      class="at-dialog"
      [open]="open()"
      [dialogTitle]="'Запустить отзыв'"
      [lightDismiss]="light"
      (closed)="open.set(false)"
    >
      <label for="code">Код партии</label>
      <input id="code" />
    </dialog>`,
})
class DialogHarness {
  static light = false;
  readonly open = signal(false);
  readonly light = DialogHarness.light;
}

@Component({
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button class="at-button" (click)="open.set(true)">Открыть</button>
    <button type="button" #other>Другое</button>
    @if (open()) {
      <dialog class="at-dialog" [open]="true" [dialogTitle]="'Фото'" (closed)="open.set(false)">
        <label for="file">Файл</label>
        <input id="file" />
        <button class="at-button" (click)="done(other)">Готово</button>
      </dialog>
    }`,
})
class MountedDialogHarness {
  static elsewhere = false;
  readonly open = signal(false);
  done(other: HTMLElement): void {
    if (MountedDialogHarness.elsewhere) other.focus();
    this.open.set(false);
  }
}

describe('at-dialog', () => {
  it('focuses the first field of the body, Esc closes, focus returns to the opener', async () => {
    DialogHarness.light = false;
    const f = mount(DialogHarness);
    const opener = screen.getByRole('button', { name: 'Открыть' });
    await userEvent.click(opener);
    const dialog = (f.nativeElement as HTMLElement).querySelector('dialog')!;
    await waitFor(() => expect(dialog).toHaveAttribute('open'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Код партии')));
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
    expect(document.activeElement).toBe(opener);
  });

  it('a confirmation dialog ignores backdrop clicks', async () => {
    DialogHarness.light = false;
    const f = mount(DialogHarness);
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    const dialog = (f.nativeElement as HTMLElement).querySelector('dialog')!;
    await waitFor(() => expect(dialog).toHaveAttribute('open'));
    fireEvent.click(dialog);
    await Promise.resolve();
    expect(dialog).toHaveAttribute('open');
  });

  it('a light-dismiss dialog closes on a backdrop click', async () => {
    DialogHarness.light = true;
    const f = mount(DialogHarness);
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    const dialog = (f.nativeElement as HTMLElement).querySelector('dialog')!;
    await waitFor(() => expect(dialog).toHaveAttribute('open'));
    fireEvent.click(dialog);
    await waitFor(() => expect(dialog).not.toHaveAttribute('open'));
    DialogHarness.light = false;
  });

  it('the cross closes', async () => {
    const f = mount(DialogHarness);
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    await waitFor(() =>
      expect((f.nativeElement as HTMLElement).querySelector('dialog')).not.toHaveAttribute('open'),
    );
  });

  it('a dialog removed by Esc or by its action returns the focus to the opener', async () => {
    MountedDialogHarness.elsewhere = false;
    mount(MountedDialogHarness);
    const opener = screen.getByRole('button', { name: 'Открыть' });
    await userEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Файл')));
    fireEvent(document.querySelector('dialog')!, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(document.querySelector('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
    await userEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Файл')));
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(document.querySelector('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('a removed dialog leaves alone a focus its screen already moved out of it', async () => {
    MountedDialogHarness.elsewhere = true;
    mount(MountedDialogHarness);
    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Файл')));
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(document.querySelector('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Другое' }));
    MountedDialogHarness.elsewhere = false;
  });
});

@Component({
  standalone: true,
  imports: [...UI],
  template: `<div class="at-toasts"></div>`,
})
class ToastsHarness {}

describe('at-toast', () => {
  it('errors go to role=alert and stay; others to aria-live=polite and hide after 5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = mount(ToastsHarness);
    const toasts = TestBed.inject(ToastService);
    f.ngZone!.run(() => {
      toasts.push({ tone: 'ok', text: 'тост ok' });
      toasts.push({ tone: 'danger', text: 'тост danger' });
    });
    await f.whenStable();
    const [alert, polite] = document.querySelectorAll('.at-toast-region');
    expect(alert!.textContent).toContain('тост danger');
    expect(polite!.textContent).toContain('тост ok');
    vi.advanceTimersByTime(TOAST_HIDE_MS + 10);
    await waitFor(() => expect(polite!.textContent!.trim()).toBe(''));
    expect(alert!.textContent).toContain('тост danger');
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(alert!.textContent!.trim()).toBe(''));
    vi.useRealTimers();
  });
});

interface Row {
  id: string;
  code: string;
}

@Component({
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div
      class="at-table-mobilebar"
      [table]="tbl"
      [sortOptions]="[
        { value: 'code,asc', label: 'Код' },
        { value: 'code,desc', label: 'Код, обратно' },
      ]"
    ></div>
    <div
      class="at-table-wrap"
      #tbl="atTable"
      [cards]="true"
      [rows]="rows"
      [rowKey]="rowKey"
      [sort]="sort()"
      [selection]="{ selected: sel(), allLabel: 'Выбрать все партии', rowLabel: rowLabel }"
      (sortChange)="sort.set($event)"
      (selectionChange)="sel.set($event)"
    >
      <ng-template [atColumn]="'code'" [header]="'Партия'" [sortField]="'code'" let-r>{{
        r.code
      }}</ng-template>
    </div>`,
})
class TableHarness {
  readonly rows: Row[] = [
    { id: 'a', code: 'AT-1' },
    { id: 'b', code: 'AT-2' },
  ];
  readonly rowKey = (r: Row) => r.id;
  readonly rowLabel = (r: Row) => `Выбрать ${r.code}`;
  readonly sort = signal<SortState | null>({ field: 'code', dir: 'asc' });
  readonly sel = signal<ReadonlySet<string>>(new Set());
}

describe('at-table', () => {
  it('sort button toggles aria-sort, the mobile select mirrors it', async () => {
    mount(TableHarness);
    const th = screen.getByRole('columnheader', { name: 'Партия' });
    expect(th).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(screen.getByRole('button', { name: 'Партия' }));
    expect(th).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('combobox', { name: 'Сортировка' })).toHaveValue('code,desc');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'code,asc');
    expect(th).toHaveAttribute('aria-sort', 'ascending');
  });

  it('row selection marks the row, the header box is indeterminate, then all', async () => {
    mount(TableHarness);
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

@Component({
  standalone: true,
  imports: [...UI],
  template: `<button class="at-button" [busy]="busy()" (click)="clicks = clicks + 1">Сохранить</button>`,
})
class BusyHarness {
  readonly busy = signal(true);
  clicks = 0;
}

describe('at-button', () => {
  it('a busy button lets no click through', async () => {
    const f = mount(BusyHarness);
    await userEvent.click(screen.getByRole('button'));
    expect(f.componentInstance.clicks).toBe(0);
    f.componentInstance.busy.set(false);
    await f.whenStable();
    await userEvent.click(screen.getByRole('button'));
    expect(f.componentInstance.clicks).toBe(1);
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
    expect(initials('«Заря»')).toBe('ЗА');
  });
});
