import { localDate, localTime, localToInstant } from './dates';

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
