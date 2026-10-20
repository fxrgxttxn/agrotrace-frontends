import { localDate, localTime, localToInstant } from './dates';

// A moment a person enters (ruling F11, README «Дата и время»): the local date (at-date, R70) and the local time
// (`HH:MM`), sent as the UTC instant; the latest allowed is now. The form keeps `date` (ISO date or null), `time` and
// the `original` instant of an edited record (kept as it is while its date and time are not changed — seconds
// included). The same rules as the React app (src/app/MomentInput.tsx there).

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

/** The instant to send; `undefined` without a date. With a date but no valid time the start of the day stands in (the
 * form check reports the time). */
export function momentWire(m: MomentValues): string | undefined {
  if (!m.date) return undefined;
  if (m.original && localDate(m.original) === m.date && localTime(m.original) === m.time) return m.original;
  return localToInstant(m.date, m.time) ?? localToInstant(m.date, '00:00') ?? undefined;
}

/** Form checks of a moment: the time is required with a date; not after now. `dateKey`/`timeKey` — the form fields. */
export function momentCheck(m: MomentValues, dateKey: string, timeKey: string, now = Date.now()) {
  const out: Record<string, string> = {};
  if (!m.date) return out;
  const at = localToInstant(m.date, m.time);
  if (!at) out[timeKey] = 'validation.required';
  else if (Date.parse(at) > now && at !== m.original) {
    // Today with a later time: the time is what is wrong, not the date (ruling F12).
    if (m.date === localDate(now)) out[timeKey] = 'moment.timeFuture';
    else out[dateKey] = 'validation.date.future';
  }
  return out;
}
