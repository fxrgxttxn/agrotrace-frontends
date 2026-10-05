import { describe, expect, it } from 'vitest';
import { canonicalHtml } from './readme';

describe('canonical DOM', () => {
  it('drops ng-* class tokens only', () => {
    expect(canonicalHtml('<input class="at-input ng-untouched ng-pristine">')).toBe(
      canonicalHtml('<input class="at-input">'),
    );
    expect(canonicalHtml('<input class="ng-untouched at-input">')).toBe(
      canonicalHtml('<input class="at-input">'),
    );
  });

  it('a class attribute of ng-* tokens only goes entirely', () => {
    expect(canonicalHtml('<input class="ng-untouched ng-valid">')).toBe(canonicalHtml('<input>'));
  });

  it('keeps everything else: an empty class attribute stays, other classes are compared as written', () => {
    expect(canonicalHtml('<input class="">')).not.toBe(canonicalHtml('<input>'));
    expect(canonicalHtml('<input class="at-input at-mono">')).not.toBe(
      canonicalHtml('<input class="at-input">'),
    );
    expect(canonicalHtml('<input class="nga">')).not.toBe(canonicalHtml('<input>'));
  });
});
