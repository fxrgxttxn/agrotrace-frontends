import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChild,
  contentChildren,
  Directive,
  inject,
  input,
  output,
  TemplateRef,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { t } from '../i18n';
import { CheckboxComponent } from './check';
import { FieldControlDirective } from './field';
import { LinkDirective } from './link';

export interface SortState {
  field: string;
  dir: 'asc' | 'desc';
}

export function parseSort(value: string | null | undefined): SortState | null {
  const m = /^(\w+),(asc|desc)$/.exec(value ?? '');
  return m ? { field: m[1]!, dir: m[2] as 'asc' | 'desc' } : null;
}

export function formatSort(s: SortState): string {
  return `${s.field},${s.dir}`;
}

export interface TableSelection<T> {
  selected: ReadonlySet<string>;
  allLabel: string;
  rowLabel: (row: T) => string;
  errorId?: string | null;
}

export interface CellContext<T> {
  $implicit: T;
}

@Directive({ selector: 'ng-template[atColumn]', standalone: true })
export class ColumnDirective<T = unknown> {
  readonly key = input.required<string>({ alias: 'atColumn' });
  readonly header = input.required<string>();
  readonly numeric = input(false);
  readonly primary = input(false);
  readonly status = input(false);
  readonly sortField = input<string | undefined>(undefined);
  readonly template = inject<TemplateRef<CellContext<T>>>(TemplateRef);
}

@Directive({ selector: 'ng-template[atRowActions]', standalone: true })
export class RowActionsDirective<T = unknown> {
  readonly template = inject<TemplateRef<CellContext<T>>>(TemplateRef);
}

@Component({
  selector: 'div.at-table-wrap[rows]',
  standalone: true,
  exportAs: 'atTable',
  imports: [NgTemplateOutlet, CheckboxComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<table class="at-table" [attr.data-cards]="cards() ? '' : null">
    @if (caption()) {
      <caption class="at-visually-hidden">
        {{
          caption()
        }}
      </caption>
    }
    <thead>
      <tr>
        @if (selection(); as sel) {
          <th class="at-table__select" scope="col">
            <label
              class="at-check"
              [checked]="all()"
              [indeterminate]="some()"
              [ariaLabel]="sel.allLabel"
              (toggled)="toggleAll()"
            ></label>
          </th>
        }
        @for (c of columns(); track c.key()) {
          <th
            scope="col"
            [attr.data-numeric]="c.numeric() ? '' : null"
            [attr.aria-sort]="ariaSort(c.sortField())"
          >
            @if (c.sortField(); as field) {
              <button class="at-table__sort" type="button" (click)="sortBy(field)">{{ c.header() }}</button>
            } @else {
              <ng-container>{{ c.header() }}</ng-container>
            }
          </th>
        }
        @if (actions()) {
          <th scope="col">
            <span class="at-visually-hidden">{{ t('ui.actions') }}</span>
          </th>
        }
      </tr>
    </thead>
    <tbody>
      @for (row of rows(); track rowKey()(row)) {
        <tr [attr.data-selected]="isSelected(row) ? '' : null">
          @if (selection(); as sel) {
            <td class="at-table__select">
              <label
                class="at-check"
                [checked]="isSelected(row)"
                [ariaLabel]="sel.rowLabel(row)"
                [invalid]="!!sel.errorId"
                [describedBy]="sel.errorId"
                (toggled)="toggle(row)"
              ></label>
            </td>
          }
          @for (c of columns(); track c.key()) {
            <td
              [attr.data-label]="c.header()"
              [attr.data-primary]="c.primary() ? '' : null"
              [attr.data-status-cell]="c.status() ? '' : null"
              [attr.data-numeric]="c.numeric() ? '' : null"
            >
              <ng-container *ngTemplateOutlet="c.template; context: { $implicit: row }" />
            </td>
          }
          @if (actions(); as a) {
            <td class="at-table__actions">
              <ng-container *ngTemplateOutlet="a.template; context: { $implicit: row }" />
            </td>
          }
        </tr>
      }
    </tbody>
  </table>`,
})
export class TableComponent<T> {
  protected readonly t = t;
  readonly rows = input.required<T[]>();
  readonly rowKey = input.required<(row: T) => string>();
  readonly caption = input<string | undefined>(undefined);
  readonly cards = input(false);
  readonly sort = input<SortState | null | undefined>(null);
  readonly selection = input<TableSelection<T> | undefined>(undefined);
  readonly sortChange = output<SortState>();
  readonly selectionChange = output<Set<string>>();

  protected readonly columns = contentChildren<ColumnDirective<T>>(ColumnDirective);
  protected readonly actions = contentChild<RowActionsDirective<T>>(RowActionsDirective);

  private readonly keys = computed(() => this.rows().map(this.rowKey()));
  private readonly selectedCount = computed(() => {
    const sel = this.selection();
    return sel ? this.keys().filter((k) => sel.selected.has(k)).length : 0;
  });
  readonly all = computed(() => this.rows().length > 0 && this.selectedCount() === this.rows().length);
  readonly some = computed(() => this.selectedCount() > 0 && !this.all());

  protected isSelected(row: T): boolean {
    return this.selection()?.selected.has(this.rowKey()(row)) ?? false;
  }

  protected ariaSort(field: string | undefined): string | null {
    if (!field) return null;
    const sort = this.sort();
    if (sort?.field !== field) return 'none';
    return sort.dir === 'asc' ? 'ascending' : 'descending';
  }

  protected sortBy(field: string): void {
    const sort = this.sort();
    this.sortChange.emit({ field, dir: sort?.field === field && sort.dir === 'asc' ? 'desc' : 'asc' });
  }

  toggleAll(): void {
    this.selectionChange.emit(this.all() ? new Set() : new Set(this.keys()));
  }

  protected toggle(row: T): void {
    const sel = this.selection();
    if (!sel) return;
    const k = this.rowKey()(row);
    const next = new Set(sel.selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    this.selectionChange.emit(next);
  }

  pickSort(value: string): void {
    const s = parseSort(value);
    if (s) this.sortChange.emit(s);
  }
}

@Component({
  selector: 'div.at-table-mobilebar[table]',
  standalone: true,
  imports: [CheckboxComponent, FieldControlDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (table().selection()) {
      <label
        class="at-check"
        [label]="t('ui.selectAll')"
        [checked]="table().all()"
        [indeterminate]="table().some()"
        (toggled)="table().toggleAll()"
      ></label>
    }
    @if (sortOptions(); as options) {
      <label class="at-table-mobilebar__sort">
        <span class="at-visually-hidden">{{ t('ui.sort') }}</span>
        <select class="at-select" (change)="table().pickSort($any($event.target).value)">
          @if (!table().sort()) {
            <option value="" disabled [selected]="true">{{ t('ui.sortDefault') }}</option>
          }
          @for (o of options; track o.value) {
            <option [value]="o.value" [selected]="o.value === current()">{{ o.label }}</option>
          }
        </select>
      </label>
    }`,
})
export class TableMobileBarComponent<T> {
  protected readonly t = t;
  readonly table = input.required<TableComponent<T>>();
  readonly sortOptions = input<{ value: string; label: string }[] | undefined>(undefined);
  protected readonly current = computed(() => {
    const s = this.table().sort();
    return s ? formatSort(s) : '';
  });
}

@Component({
  selector: 'span.at-table__primary[code]',
  standalone: true,
  imports: [LinkDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<a class="at-mono" [to]="href()">{{ code() }}</a>
    @if (sub() !== undefined) {
      <span class="at-table__sub">{{ sub() }}</span>
    }`,
})
export class TablePrimaryComponent {
  readonly href = input.required<string>();
  readonly code = input.required<string>();
  readonly sub = input<string | undefined>(undefined);
}
