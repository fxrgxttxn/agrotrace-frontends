const DAY = 86_400_000;

export const utcDate = (iso: string): string => iso.slice(0, 10);

export function addDaysToDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/**
 * Adds N working days (Mon-Fri) to an ISO instant, skipping Saturdays and
 * Sundays by UTC calendar date; the time of day is preserved. Holidays are
 * not considered - weekends only (R24). days=0 returns the input unchanged,
 * even if `from` falls on a weekend.
 */
export function addWorkingDays(i: { from: string; days: number }): { result: string } {
  const d = new Date(i.from);
  let left = i.days;
  while (left > 0) {
    d.setTime(d.getTime() + DAY);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return { result: d.toISOString() };
}

export function recallTaskDueAt(i: { openedAt: string }): { dueAt: string } {
  return { dueAt: new Date(Date.parse(i.openedAt) + DAY).toISOString() };
}

export function isOverdue(i: { dueAt: string; now: string }): { overdue: boolean } {
  return { overdue: Date.parse(i.now) > Date.parse(i.dueAt) };
}

export function canEditTreatment(i: { createdAt: string; now: string }): { allowed: boolean } {
  return { allowed: Date.parse(i.now) - Date.parse(i.createdAt) <= DAY };
}
