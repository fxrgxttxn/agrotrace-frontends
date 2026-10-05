export function iso(t: number | string | Date): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new RangeError(`invalid time: ${String(t)}`);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const ms = (t: string): number => Date.parse(t);

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export const utcDate = (t: number | string): string => iso(t).slice(0, 10);

export const unix = (t: number): number => Math.floor(t / 1000);
