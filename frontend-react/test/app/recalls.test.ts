import { describe, expect, it } from 'vitest';
import { complaintActions, deadline, durationText, taskConfirmable } from '../../src/app/recalls';

const H = 3600_000;
const M = 60_000;

describe('durationText', () => {
  it('days and hours, hours and minutes, minutes, under a minute', () => {
    expect(durationText(26 * H + 5 * M)).toBe('1 д 2 ч');
    expect(durationText(5 * H + 12 * M + 59_000)).toBe('5 ч 12 мин');
    expect(durationText(3 * M)).toBe('3 мин');
    expect(durationText(20_000)).toBe('меньше минуты');
  });
});

describe('deadline', () => {
  const dueAt = '2026-09-25T09:00:00Z';
  it('before the deadline: the time left', () => {
    const now = Date.parse(dueAt) - (2 * H + 30 * M);
    expect(deadline({ dueAt, status: 'OPEN' }, now)).toEqual({ overdue: false, text: 'осталось 2 ч 30 мин' });
  });
  it('past the deadline (even while the server still says OPEN): overdue, by how much', () => {
    const now = Date.parse(dueAt) + 3 * H + M;
    expect(deadline({ dueAt, status: 'OPEN' }, now)).toEqual({
      overdue: true,
      text: 'просрочено на 3 ч 1 мин',
    });
  });
  it('exactly at the deadline: not overdue yet (now > dueAt)', () => {
    expect(deadline({ dueAt, status: 'OPEN' }, Date.parse(dueAt))?.overdue).toBe(false);
  });
  it('a confirmed task has no timer', () => {
    expect(deadline({ dueAt, status: 'CONFIRMED' }, Date.parse(dueAt) + H)).toBeNull();
  });
});

describe('state machines of the contract', () => {
  it('a task is confirmed from OPEN and OVERDUE', () => {
    expect(taskConfirmable('OPEN')).toBe(true);
    expect(taskConfirmable('OVERDUE')).toBe(true);
    expect(taskConfirmable('CONFIRMED')).toBe(false);
  });
  it('a complaint: NEW — review and decide; IN_REVIEW — decide; DECIDED — nothing', () => {
    expect(complaintActions('NEW')).toEqual(['review', 'decide']);
    expect(complaintActions('IN_REVIEW')).toEqual(['decide']);
    expect(complaintActions('DECIDED')).toEqual([]);
  });
});
