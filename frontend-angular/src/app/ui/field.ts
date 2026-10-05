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

export abstract class FieldContext {
  abstract readonly controlId: Signal<string>;
  abstract readonly errorId: Signal<string | null>;
  abstract readonly invalid: Signal<boolean>;
}

@Component({
  selector:
    'div.at-field:not([files]):not([orgPicker]):not([dateFilter]):not([cellId]):not([batchPicker]):not([idFilter]):not([recallPicker])',
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
  readonly fieldId = input.required<string>();
  readonly label = input.required<string>();
  readonly error = input<string | null | undefined>(null);

  readonly controlId = computed(() => this.fieldId());
  readonly errorId = computed(() => (this.error() ? `${this.fieldId()}-error` : null));
  readonly invalid = computed(() => Boolean(this.error()));
}

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

@Component({
  selector: 'div.at-input-group[suffix]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ng-content /><span class="at-input-group__suffix">{{ suffix() }}</span>`,
})
export class InputGroupComponent {
  readonly suffix = input.required<string>();
}

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
