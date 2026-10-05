import { describe, it, expect } from 'vitest';
import { compareCodePoints } from '../src/strings';

const utf8 = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

describe('compareCodePoints (R92)', () => {
  const pairs: [string, string][] = [
    ['A', 'B'],
    ['B', 'a'],
    ['a', 'ab'],
    ['', 'a'],
    ['Ａ', '\u{1D400}'],
    ['\u{1D400}', '\u{1D401}'],
    ['x\u{1F600}', 'x￿'],
    ['Ёж', 'Жук'],
    ['same', 'same'],
  ];
  for (const [a, b] of pairs) {
    it(`${JSON.stringify(a)} vs ${JSON.stringify(b)} matches UTF-8 byte order`, () => {
      expect(compareCodePoints(a, b)).toBe(utf8(a, b));
      expect(compareCodePoints(b, a)).toBe(utf8(b, a));
    });
  }
  it('differs from JS `<` for astral vs high-BMP characters', () => {
    expect('\u{1D400}' < 'Ａ').toBe(true);
    expect(compareCodePoints('\u{1D400}', 'Ａ')).toBe(1);
  });
});
