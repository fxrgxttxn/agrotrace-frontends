import { describe, it, expect } from 'vitest';
import { kgToGrams } from '../src/decimal';

describe('kgToGrams (R26 bounds)', () => {
  it('"12" -> 12000n (bare integer, no decimal point)', () => {
    expect(kgToGrams('12')).toBe(12000n);
  });

  it('"1.5" -> 1500n (fewer than 3 decimal digits accepted)', () => {
    expect(kgToGrams('1.5')).toBe(1500n);
  });

  it('"999999999.999" is accepted (exactly 9 integer digits, the numeric(12,3) cap)', () => {
    expect(kgToGrams('999999999.999')).toBe(999999999999n);
  });

  it('"1000000000.000" throws (10 integer digits exceeds the cap)', () => {
    expect(() => kgToGrams('1000000000.000')).toThrow(RangeError);
  });

  it('"" throws (empty string)', () => {
    expect(() => kgToGrams('')).toThrow(RangeError);
  });

  it('" 1.000" throws (leading space)', () => {
    expect(() => kgToGrams(' 1.000')).toThrow(RangeError);
  });

  it('"-1.000" throws (negative sign not accepted)', () => {
    expect(() => kgToGrams('-1.000')).toThrow(RangeError);
  });

  it('"1.0000" throws (more than 3 decimal digits)', () => {
    expect(() => kgToGrams('1.0000')).toThrow(RangeError);
  });
});
