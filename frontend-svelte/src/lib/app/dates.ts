export function todayUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function dateToInstant(date: string): string {
  return `${date}T00:00:00Z`;
}

export function addDays(instant: string, days: number): string {
  return new Date(Date.parse(instant) + days * 86400000).toISOString().replace('.000Z', 'Z');
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localDate(at: number | string = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localTime(at: number | string = Date.now()): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localToInstant(date: string | null, time: string): string | null {
  if (!date || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${date}T${time}:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
