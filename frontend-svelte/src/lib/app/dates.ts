// The same date helpers as the React app (src/app/dates.ts there).
// Calendar dates of the forms and filters are UTC dates, as everywhere in the contract (`from`/`to` filters «по дате
// UTC», `formatDate` shows the UTC date of an instant). A picked date is sent as its UTC midnight, which is never in
// the future while the date is not after today (UTC) — the date fields take today (UTC) as their maximum.

/** Today's UTC date, `YYYY-MM-DD`. */
export function todayUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The instant of a picked date: its UTC midnight. */
export function dateToInstant(date: string): string {
  return `${date}T00:00:00Z`;
}

/** `instant` + `days` whole days (UTC), as an instant. */
export function addDays(instant: string, days: number): string {
  return new Date(Date.parse(instant) + days * 86400000).toISOString().replace('.000Z', 'Z');
}

// Moments people enter (when a field was treated, when a crop was harvested — ruling F11) are a local date and time
// in the viewer's time zone, sent as the UTC instant; the latest allowed is now.

const pad = (n: number) => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD` of an instant (or of now). */
export function localDate(at: number | string = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local `HH:MM` of an instant (or of now). */
export function localTime(at: number | string = Date.now()): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The UTC instant (`…Z`, whole seconds) of a local date and `HH:MM`; `null` when either is not valid. */
export function localToInstant(date: string | null, time: string): string | null {
  if (!date || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${date}T${time}:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
