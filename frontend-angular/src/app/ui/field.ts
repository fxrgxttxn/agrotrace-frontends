import {
  ChangeDetectionStrategy,
  Component,
  computed,
  Directive,
  HostAttributeToken,
  inject,
  input,
  type Signal,
} from '@angular/core';

/** What a control inside an `at-field` takes from it: the id, the invalid state and the error reference. */
export abstract class FieldContext {
  abstract readonly controlId: Signal<string>;
  abstract readonly errorId: Signal<string | null>;
  abstract readonly invalid: Signal<boolean>;
}

/** `at-field` (README «Поле формы»): label + control + error; the error element exists only with an error. Controls
 * inside (`at-input`, `at-textarea`, `at-select`, `at-date`, `at-combobox`) take the id / `aria-invalid` /
 * `aria-describedby` from it. */
@Component({
  selector: 'div.at-field:not([files]):not([orgPicker]):not([dateFilter]):not([cellId])',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: FieldContext, useExisting: FieldComponent }],
  template: `<label class="at-field__label" [attr.for]="fieldId()">{{ label() }}</label>
    <ng-content />
    @if (error()) {
      <p class="at-field__error" [attr.id]="errorId()" role="alert">{{ error() }}</p>
    }`,
  host: { '[attr.data-invalid]': "error() ? '' : null" },
})
export class FieldComponent extends FieldContext {
  /** Id of the control; the label points at it, the error element is `${fieldId}-error`. */
  readonly fieldId = input.required<string>();
  readonly label = input.required<string>();
  /** Error text (already translated). */
  readonly error = input<string | null | undefined>(null);

  readonly controlId = computed(() => this.fieldId());
  readonly errorId = computed(() => (this.error() ? `${this.fieldId()}-error` : null));
  readonly invalid = computed(() => Boolean(this.error()));
}

/** Group of checkboxes / radios: `<fieldset class="at-field"><legend class="at-field__label">`. */
@Component({
  selector: 'fieldset.at-field[legend]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<legend class="at-field__label">{{ legend() }}</legend>
    <div class="at-field__options" [attr.data-direction]="direction()"><ng-content /></div>
    @if (error()) {
      <p class="at-field__error" [attr.id]="errorId() ?? null" role="alert">{{ error() }}</p>
    }`,
  host: { '[attr.data-invalid]': "error() ? '' : null" },
})
export class FieldSetComponent {
  readonly legend = input.required<string>();
  readonly error = input<string | null | undefined>(null);
  readonly errorId = input<string | undefined>(undefined);
  readonly direction = input<'column' | 'row'>('column');
}

/** Native text controls (README «Текстовые поля», «Список»): `at-input` (`at-mono` for codes), `at-textarea`,
 * `at-select`. Inside an `at-field` they take its id, `aria-invalid` and `aria-describedby`; `id` / `invalid` /
 * `describedBy` given here win (wrappers such as `at-date` pass theirs). Inputs of the wrappers are always bound
 * (`[x]="…"`): a static attribute would also stay in the DOM. */
@Directive({
  selector: 'input.at-input, textarea.at-textarea, select.at-select',
  standalone: true,
  host: {
    '[attr.id]': 'resolvedId()',
    '[attr.aria-invalid]': "resolvedInvalid() ? 'true' : null",
    '[attr.aria-describedby]': 'resolvedDescribedBy()',
  },
})
export class FieldControlDirective {
  /** Id given by a wrapper (`at-date`, `at-combobox`); a static `id="…"` in the markup is read as an attribute. */
  readonly controlId = input<string | null | undefined>(undefined);
  private readonly staticId = inject(new HostAttributeToken('id'), { optional: true });
  readonly invalid = input<boolean | undefined>(undefined);
  readonly describedBy = input<string | null | undefined>(undefined);
  private readonly field = inject(FieldContext, { optional: true });

  protected readonly resolvedId = computed(
    () => this.controlId() ?? this.staticId ?? this.field?.controlId() ?? null,
  );
  protected readonly resolvedInvalid = computed(() => this.invalid() ?? this.field?.invalid() ?? false);
  protected readonly resolvedDescribedBy = computed(
    () => [this.describedBy(), this.field?.errorId()].filter(Boolean).join(' ') || null,
  );
}

/** `at-input-group`: a number aligned right against its unit (`кг`, `га`, `мг/кг`). */
@Component({
  selector: 'div.at-input-group[suffix]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ng-content /><span class="at-input-group__suffix">{{ suffix() }}</span>`,
})
export class InputGroupComponent {
  readonly suffix = input.required<string>();
}

/** A field inside a table cell (README «Таблица»: the declared mass of a waybill row, the used mass of a processing
 * input): `div.at-field` without a label — the control is named by its own `aria-label`; the error as a field's
 * (`<id>-error`, `aria-describedby`). The React app's `CellField`. */
@Component({
  selector: 'div.at-field[cellId]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: FieldContext, useExisting: CellFieldComponent }],
  template: `<ng-content />
    @if (error()) {
      <p class="at-field__error" [attr.id]="errorId()" role="alert">{{ error() }}</p>
    }`,
  host: { '[attr.data-invalid]': "error() ? '' : null" },
})
export class CellFieldComponent extends FieldContext {
  readonly cellId = input.required<string>();
  readonly error = input<string | null | undefined>(null);

  readonly controlId = computed(() => this.cellId());
  readonly errorId = computed(() => (this.error() ? `${this.cellId()}-error` : null));
  readonly invalid = computed(() => Boolean(this.error()));
}
