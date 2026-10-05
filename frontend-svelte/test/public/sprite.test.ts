import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import alert from '@agrotrace/design-system/icons/alert.svg?raw';
import check from '@agrotrace/design-system/icons/check.svg?raw';
import clock from '@agrotrace/design-system/icons/clock.svg?raw';
import { injectPublicIcons, symbolOf } from '../../src/lib/public/sprite';
import { injectSprite } from '../../src/lib/app/sprite';

const sprite = readFileSync('../packages/design-system/sprite.svg', 'utf8');

const symbolIn = (svg: string, name: string) =>
  new RegExp(`<symbol id="i-${name}"[^]*?</symbol>`).exec(svg)?.[0];
const flat = (s: string | undefined) => (s ?? '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

describe('public sprite', () => {
  it.each([
    ['alert', alert],
    ['check', check],
    ['clock', clock],
  ])('the %s symbol is the one of sprite.svg', (name, raw) => {
    expect(flat(symbolOf(name, raw))).toBe(flat(symbolIn(sprite, name)));
  });

  it('is put once, first in <body>; the whole sprite replaces it', () => {
    document.getElementById('at-sprite')?.remove();
    injectPublicIcons();
    injectPublicIcons();
    expect(document.querySelectorAll('#at-sprite')).toHaveLength(1);
    expect(document.body.firstElementChild?.id).toBe('at-sprite');
    expect(document.querySelectorAll('#at-sprite symbol')).toHaveLength(3);
    injectSprite();
    expect(document.querySelectorAll('#at-sprite')).toHaveLength(1);
    expect(document.getElementById('at-sprite')!.hasAttribute('data-subset')).toBe(false);
    expect(document.querySelectorAll('#at-sprite symbol').length).toBeGreaterThan(3);
  });
});
