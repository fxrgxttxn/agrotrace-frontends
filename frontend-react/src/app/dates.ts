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
