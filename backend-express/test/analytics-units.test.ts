/** Pure analytics helpers: `Hours`, minute truncation of report moments, the window rules (analytics.yaml). */
import { describe, expect, it } from 'vitest';
import { hours } from '../src/modules/analytics/dashboard.js';
import { bounds, resolveWindow, tooLong } from '../src/modules/analytics/window.js';
import { minute } from '../src/modules/reports/sheets.js';

describe('Hours (S / (N × 3600), half up, two decimals)', () => {
  it('rounds half up and returns null without records', () => {
    expect(hours(0, 0)).toBeNull();
    expect(hours(3600, 1)).toBe('1.00');
    expect(hours(18 * 3600 + 15 * 60, 1)).toBe('18.25');
    expect(hours(18, 1)).toBe('0.01'); // 0.005 h → half up
    expect(hours(17, 1)).toBe('0.00');
    expect(hours(3600 + 7200, 2)).toBe('1.50');
    expect(hours('999999999999', 1)).toBe('277777777.78');
  });
});

describe('report moments', () => {
  it('YYYY-MM-DD HH:MM in UTC, seconds truncated (never rounded)', () => {
    expect(minute(new Date('2026-09-24T10:59:59.999Z'))).toBe('2026-09-24 10:59');
    expect(minute('2026-12-31T23:59:30Z')).toBe('2026-12-31 23:59');
    expect(minute(null)).toBeNull();
  });
});

describe('window', () => {
  it('defaults: 30 days to today; one end → 30 days from it; explicit bounds kept', () => {
    expect(resolveWindow(undefined, undefined, '2026-09-24')).toEqual({
      from: '2026-08-26',
      to: '2026-09-24',
    });
    expect(resolveWindow('2026-02-01', undefined, 'x')).toEqual({ from: '2026-02-01', to: '2026-03-02' });
    expect(resolveWindow(undefined, '2026-03-01', 'x')).toEqual({ from: '2026-01-31', to: '2026-03-01' });
    expect(resolveWindow('2026-01-01', '2026-01-01', 'x')).toEqual({ from: '2026-01-01', to: '2026-01-01' });
  });

  it('at most 366 days (inclusive); half-open instant bounds', () => {
    expect(tooLong('2024-01-01', '2024-12-31')).toBe(false); // leap year, 366 days
    expect(tooLong('2024-01-01', '2025-01-01')).toBe(true);
    expect(tooLong(undefined, '2026-01-01')).toBe(false);
    expect(bounds({ from: '2026-01-01', to: '2026-01-31' })).toEqual({
      start: new Date('2026-01-01T00:00:00Z'),
      end: new Date('2026-02-01T00:00:00Z'),
    });
  });
});
