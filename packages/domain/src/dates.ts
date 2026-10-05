const DAY = 86_400_000;

export const utcDate = (iso: string): string => iso.slice(0, 10);

export function addDaysToDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

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
