import type { Schemas } from '@agrotrace/api-client';
import { isOverdue } from '@agrotrace/domain';
import machines from '../../../contracts/rules/entity-state-machines.json';
import { t } from './i18n';
import type { Tone } from '../ui';

type RecallStatus = Schemas['RecallStatus'];
type TaskStatus = Schemas['RecallTaskStatus'];
type ComplaintStatus = Schemas['ComplaintStatus'];

export const RECALL_TONE: Record<RecallStatus, Tone> = { OPEN: 'danger', CLOSED: 'ok' };
export const TASK_TONE: Record<TaskStatus, Tone> = { OPEN: 'attention', OVERDUE: 'danger', CONFIRMED: 'ok' };
export const COMPLAINT_TONE: Record<ComplaintStatus, Tone> = {
  NEW: 'attention',
  IN_REVIEW: 'move',
  DECIDED: 'neutral',
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function durationText(ms: number): string {
  const span = Math.max(0, ms);
  if (span >= DAY)
    return t('duration.days', { days: Math.floor(span / DAY), hours: Math.floor((span % DAY) / HOUR) });
  if (span >= HOUR)
    return t('duration.hours', {
      hours: Math.floor(span / HOUR),
      minutes: Math.floor((span % HOUR) / MINUTE),
    });
  if (span >= MINUTE) return t('duration.minutes', { minutes: Math.floor(span / MINUTE) });
  return t('duration.lessThanMinute');
}

export function deadline(
  task: { dueAt: string; status: TaskStatus },
  now: number,
): { overdue: boolean; text: string } | null {
  if (task.status === 'CONFIRMED') return null;
  const due = Date.parse(task.dueAt);
  const { overdue } = isOverdue({ dueAt: task.dueAt, now: new Date(now).toISOString() });
  return overdue
    ? { overdue, text: t('duration.late', { time: durationText(now - due) }) }
    : { overdue, text: t('duration.left', { time: durationText(due - now) }) };
}

type Machine = { transitions: { from: string; action: string; by: string }[] };
const actionsOf = (machine: Machine, from: string) => [
  ...new Set(machine.transitions.filter((x) => x.from === from && x.by !== 'system').map((x) => x.action)),
];

export function taskConfirmable(status: TaskStatus): boolean {
  return actionsOf(machines.recallTask, status).includes('confirm');
}

export function complaintActions(status: ComplaintStatus): ('review' | 'decide')[] {
  return actionsOf(machines.complaint, status) as ('review' | 'decide')[];
}
