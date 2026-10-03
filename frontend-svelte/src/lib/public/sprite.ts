import alert from '@agrotrace/design-system/icons/alert.svg?raw';
import check from '@agrotrace/design-system/icons/check.svg?raw';
import clock from '@agrotrace/design-system/icons/clock.svg?raw';

// The public QR page's sprite: only the icons it shows (README «Публичная QR-страница»: the whole sprite.svg is not in
// its budget). The symbols are built exactly as packages/design-system/scripts/build-sprite.ts builds them, so
// `<use href="#i-<name>">` works the same; the sprite is put once, first in <body> (as the React app's spriteSubset).

const RULES =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
const compact = (markup: string) => markup.trim().replace(/>\s+</g, '><').replace(/\s+/g, ' ');

/** `<symbol id="i-<name>" …>` of an icon file's raw text. */
export function symbolOf(name: string, raw: string): string {
  const body = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(raw)?.[1] ?? '';
  return `<symbol id="i-${name}" ${RULES}>${compact(body)}</symbol>`;
}

export function injectPublicIcons(doc: Document = document): void {
  if (doc.getElementById('at-sprite')) return;
  const tpl = doc.createElement('template');
  tpl.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position: absolute; width: 0; height: 0; overflow: hidden">' +
    Object.entries({ alert, check, clock })
      .map(([name, raw]) => symbolOf(name, raw))
      .join('') +
    '</svg>';
  const svg = tpl.content.firstElementChild!;
  svg.id = 'at-sprite';
  svg.setAttribute('data-subset', '');
  doc.body.prepend(svg);
}
