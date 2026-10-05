import type { FieldValues, Path, PathValue, UseFormReturn } from 'react-hook-form';
import { localDate, localTime, localToInstant } from './dates';
import { errorOf } from './forms';
import { DateInput, Field, Input } from '../ui';

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

export function MomentInput<F extends FieldValues>({
  form,
  id,
  dateName,
  timeName,
  dateLabel,
  timeLabel,
}: {
  form: UseFormReturn<F>;
  id: string;
  dateName: Path<F>;
  timeName: Path<F>;
  dateLabel: string;
  timeLabel: string;
}) {
  const date = form.watch(dateName) as string | null;
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--sp-4)',
        gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
      }}
    >
      <Field id={`${id}-date`} label={dateLabel} error={errorOf(form, dateName)}>
        <DateInput
          value={date}
          max={localDate()}
          onChange={(iso) => form.setValue(dateName, iso as PathValue<F, Path<F>>, { shouldDirty: true })}
          onValidate={(err) =>
            err ? form.setError(dateName, { type: 'date', message: err }) : form.clearErrors(dateName)
          }
        />
      </Field>
      <Field id={`${id}-time`} label={timeLabel} error={errorOf(form, timeName)}>
        <Input type="time" {...form.register(timeName)} />
      </Field>
    </div>
  );
}
