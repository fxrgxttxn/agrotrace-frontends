import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { localDate, localTime, localToInstant } from './dates';
import type { SchemaForm } from './forms';
import { DateInputComponent, FieldComponent, FieldControlDirective, type DateError } from './ui';

export interface MomentValues {
  date: string | null;
  time: string;
  original: string | null;
}

export function momentDefaults(original: string | null | undefined): MomentValues {
  return original
    ? { date: localDate(original), time: localTime(original), original }
    : { date: null, time: localTime(), original: null };
}

export function momentWire(m: MomentValues): string | undefined {
  if (!m.date) return undefined;
  if (m.original && localDate(m.original) === m.date && localTime(m.original) === m.time) return m.original;
  return localToInstant(m.date, m.time) ?? localToInstant(m.date, '00:00') ?? undefined;
}

export function momentCheck(m: MomentValues, dateKey: string, timeKey: string, now = Date.now()) {
  const out: Record<string, string> = {};
  if (!m.date) return out;
  const at = localToInstant(m.date, m.time);
  if (!at) out[timeKey] = 'validation.required';
  else if (Date.parse(at) > now && at !== m.original) {
    if (m.date === localDate(now)) out[timeKey] = 'moment.timeFuture';
    else out[dateKey] = 'validation.date.future';
  }
  return out;
}

@Component({
  selector: 'div[atMoment]',
  standalone: true,
  imports: [ReactiveFormsModule, DateInputComponent, FieldComponent, FieldControlDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div
      class="at-field"
      [fieldId]="atMoment() + '-date'"
      [label]="dateLabel()"
      [error]="form().errorOf(dateName())"
    >
      <div
        class="at-date"
        [value]="date()"
        [max]="today"
        (valueChange)="setDate($event)"
        (validate)="checked($event)"
      ></div>
    </div>
    <div
      class="at-field"
      [fieldId]="atMoment() + '-time'"
      [label]="timeLabel()"
      [error]="form().errorOf(timeName())"
    >
      <input class="at-input" type="time" [formControl]="form().control(timeName())" />
    </div>`,
  host: {
    style: 'display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr))',
  },
})
export class MomentInputComponent {
  readonly atMoment = input.required<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly form = input.required<SchemaForm<any, any>>();
  readonly dateName = input.required<string>();
  readonly timeName = input.required<string>();
  readonly dateLabel = input.required<string>();
  readonly timeLabel = input.required<string>();
  protected readonly today = localDate();

  private readonly control = computed(() => this.form().control(this.dateName()));
  protected readonly date = computed(() => this.form().valueOf<string | null>(this.dateName()) ?? null);

  protected setDate(iso: string | null): void {
    this.control().setValue(iso);
    this.control().markAsDirty();
  }

  protected checked(err: DateError | null): void {
    this.form().fieldError(this.dateName(), err);
  }
}
