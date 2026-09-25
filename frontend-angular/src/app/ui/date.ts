import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  type OnChanges,
  type SimpleChanges,
} from '@angular/core';
import { formatRuDate, isWithinRuDateBounds, maskRuDateInput, parseRuDate } from '@agrotrace/i18n';
import { t } from '../i18n';
import { FieldContext, FieldControlDirective } from './field';

export type DateError = 'validation.date.format' | 'validation.range';

/** Translated text of a {@link DateError}. */
export function dateErrorText(error: DateError | null): string | null {
  return error ? t(error) : null;
}

/** `at-date` (README «Дата», ruling R70): a text field that always shows and accepts ДД.ММ.ГГГГ, plus a calendar
 * button that opens a hidden native date input with `showPicker()`. The model value is an ISO date. */
@Component({
  selector: 'div.at-date',
  standalone: true,
  imports: [FieldControlDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<input
      #text
      class="at-input"
      [controlId]="controlId()"
      [invalid]="invalid()"
      [describedBy]="describedBy()"
      [attr.name]="name() ?? null"
      inputmode="numeric"
      placeholder="ДД.ММ.ГГГГ"
      maxlength="10"
      autocomplete="off"
      [disabled]="disabled()"
      [value]="shown()"
      (input)="onInput()"
      (blur)="onBlur()"
    />
    <button
      class="at-date__button"
      type="button"
      [attr.aria-label]="t('ui.openCalendar')"
      [disabled]="disabled()"
      (click)="openPicker()"
    >
      <svg aria-hidden="true"><use href="#i-calendar"></use></svg>
    </button>
    <input
      #native
      class="at-date__native"
      type="date"
      tabindex="-1"
      aria-hidden="true"
      [attr.min]="min() ?? null"
      [attr.max]="max() ?? null"
      [disabled]="disabled()"
      (change)="onNative()"
    />`,
})
export class DateInputComponent implements OnChanges {
  protected readonly t = t;
  /** ISO `YYYY-MM-DD`, or `''` / `null` for empty. */
  readonly value = input<string | null>(null);
  readonly min = input<string | undefined>(undefined);
  readonly max = input<string | undefined>(undefined);
  readonly disabled = input(false);
  readonly name = input<string | undefined>(undefined);
  readonly id = input<string | undefined>(undefined);
  readonly invalid = input<boolean | undefined>(undefined);
  readonly describedBy = input<string | undefined>(undefined);
  /** ISO date, or `null` when the text is empty or not (yet) a complete valid date. */
  readonly valueChange = output<string | null>();
  /** After blur (and on a calendar pick): the field error key for the typed text, or `null`. */
  readonly validate = output<DateError | null>();
  readonly blurred = output<void>();

  private readonly field = inject(FieldContext, { optional: true });
  protected readonly controlId = computed(() => this.id() ?? this.field?.controlId() ?? null);
  private readonly textRef = viewChild<ElementRef<HTMLInputElement>>('text');
  private readonly nativeRef = viewChild.required<ElementRef<HTMLInputElement>>('native');
  protected readonly shown = signal('');

  ngOnChanges(changes: SimpleChanges): void {
    // An external model change (form reset, server value) replaces the text unless it already shows that date.
    if (!changes['value']) return;
    const v = this.value();
    if (parseRuDate(this.shown()) !== (v || null)) this.show(formatRuDate(v));
  }

  private show(text: string): void {
    this.shown.set(text);
    const el = this.textRef()?.nativeElement;
    if (el && el.value !== text) el.value = text;
  }

  private check(typed: string): DateError | null {
    if (!typed.trim()) return null;
    const iso = parseRuDate(typed);
    if (!iso) return 'validation.date.format';
    return isWithinRuDateBounds(iso, this.min(), this.max()) ? null : 'validation.range';
  }

  protected onInput(): void {
    const masked = maskRuDateInput(this.textRef()!.nativeElement.value);
    this.show(masked);
    this.valueChange.emit(parseRuDate(masked));
  }

  protected onBlur(): void {
    this.validate.emit(this.check(this.shown()));
    this.blurred.emit();
  }

  protected openPicker(): void {
    const native = this.nativeRef().nativeElement;
    native.value = parseRuDate(this.shown()) ?? '';
    try {
      native.showPicker();
    } catch {
      native.focus();
    }
  }

  protected onNative(): void {
    const next = formatRuDate(this.nativeRef().nativeElement.value);
    this.show(next);
    this.valueChange.emit(parseRuDate(next));
    this.validate.emit(this.check(next));
    this.textRef()?.nativeElement.focus();
  }
}
