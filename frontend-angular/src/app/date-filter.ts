import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { t } from './i18n';
import { DateInputComponent, FieldContext, type DateError } from './ui';

@Component({
  selector: 'div.at-field[dateFilter]',
  standalone: true,
  imports: [DateInputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: FieldContext, useExisting: DateFilterComponent }],
  template: `<label class="at-field__label" [attr.for]="dateFilter()">{{ label() }}</label>
    <div
      class="at-date"
      [value]="value() || null"
      [min]="min()"
      [max]="max()"
      (valueChange)="changed($event)"
      (validate)="checked($event)"
    ></div>
    @if (errorText()) {
      <p class="at-field__error" [attr.id]="errorId()" role="alert">{{ errorText() }}</p>
    }`,
  host: { '[attr.data-invalid]': "errorText() ? '' : null" },
})
export class DateFilterComponent extends FieldContext {
  readonly dateFilter = input.required<string>();
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly min = input<string | undefined>(undefined);
  readonly max = input<string | undefined>(undefined);
  readonly valueChange = output<string | null>();

  private readonly error = signal<DateError | null>(null);
  protected readonly errorText = computed(() => (this.error() ? t(this.error()!) : null));
  readonly controlId = computed(() => this.dateFilter());
  readonly errorId = computed(() => (this.error() ? `${this.dateFilter()}-error` : null));
  readonly invalid = computed(() => Boolean(this.error()));
  private latest: string | null = null;

  constructor() {
    super();
    effect(() => {
      const v = this.value();
      untracked(() => (this.latest = v || null));
    });
  }

  protected changed(iso: string | null): void {
    this.latest = iso;
    if (iso && iso !== this.value()) this.valueChange.emit(iso);
  }

  protected checked(err: DateError | null): void {
    this.error.set(err);
    if (!err && this.latest === null && this.value()) this.valueChange.emit(null);
  }
}
