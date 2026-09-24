import { describe, expect, it } from 'vitest';
import { formatRuDate, isWithinRuDateBounds, maskRuDateInput, parseRuDate } from '../src/index.js';

describe('formatRuDate', () => {
  it('formats an ISO date as ДД.ММ.ГГГГ', () => {
    expect(formatRuDate('2026-08-14')).toBe('14.08.2026');
    expect(formatRuDate('2026-01-05T09:40:00Z')).toBe('05.01.2026');
  });

  it('returns an empty string for empty or malformed input', () => {
    expect(formatRuDate('')).toBe('');
    expect(formatRuDate(null)).toBe('');
    expect(formatRuDate('14.08.2026')).toBe('');
  });
});

describe('parseRuDate', () => {
  it('parses a complete ДД.ММ.ГГГГ into an ISO date', () => {
    expect(parseRuDate('14.08.2026')).toBe('2026-08-14');
    expect(parseRuDate(' 29.02.2028 ')).toBe('2028-02-29');
  });

  it('rejects impossible calendar dates', () => {
    expect(parseRuDate('31.02.2026')).toBeNull();
    expect(parseRuDate('29.02.2026')).toBeNull();
    expect(parseRuDate('00.08.2026')).toBeNull();
    expect(parseRuDate('14.13.2026')).toBeNull();
  });

  it('rejects incomplete or differently shaped input', () => {
    expect(parseRuDate('')).toBeNull();
    expect(parseRuDate('14.08')).toBeNull();
    expect(parseRuDate('1.8.2026')).toBeNull();
    expect(parseRuDate('14.08.26')).toBeNull();
    expect(parseRuDate('2026-08-14')).toBeNull();
  });

  it('round-trips with formatRuDate', () => {
    expect(parseRuDate(formatRuDate('2026-12-31'))).toBe('2026-12-31');
  });
});

describe('maskRuDateInput', () => {
  it('inserts the dots while typing and keeps at most 8 digits', () => {
    expect(maskRuDateInput('1')).toBe('1');
    expect(maskRuDateInput('14')).toBe('14');
    expect(maskRuDateInput('140')).toBe('14.0');
    expect(maskRuDateInput('1408')).toBe('14.08');
    expect(maskRuDateInput('14082')).toBe('14.08.2');
    expect(maskRuDateInput('14082026')).toBe('14.08.2026');
    expect(maskRuDateInput('140820261')).toBe('14.08.2026');
  });

  it('ignores anything that is not a digit', () => {
    expect(maskRuDateInput('14.08.2026')).toBe('14.08.2026');
    expect(maskRuDateInput('14/08/2026')).toBe('14.08.2026');
    expect(maskRuDateInput('ab1c4')).toBe('14');
    expect(maskRuDateInput('')).toBe('');
  });

  it('converts a pasted ISO date', () => {
    expect(maskRuDateInput('2026-08-14')).toBe('14.08.2026');
  });
});

describe('isWithinRuDateBounds', () => {
  it('accepts dates inside inclusive min/max bounds', () => {
    expect(isWithinRuDateBounds('2026-08-14', '2026-08-14', '2026-08-14')).toBe(true);
    expect(isWithinRuDateBounds('2026-08-14', '2026-01-01', '2026-12-31')).toBe(true);
  });
  it('rejects dates outside the bounds', () => {
    expect(isWithinRuDateBounds('2025-12-31', '2026-01-01', null)).toBe(false);
    expect(isWithinRuDateBounds('2026-09-25', null, '2026-09-24')).toBe(false);
  });
  it('treats missing or empty bounds as open', () => {
    expect(isWithinRuDateBounds('1900-01-01', undefined, '')).toBe(true);
    expect(isWithinRuDateBounds('2999-01-01')).toBe(true);
  });
  it('rejects a malformed ISO value', () => {
    expect(isWithinRuDateBounds('14.08.2026', '2026-01-01')).toBe(false);
  });
});
