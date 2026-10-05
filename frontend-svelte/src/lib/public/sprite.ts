import alert from '@agrotrace/design-system/icons/alert.svg?raw';
import check from '@agrotrace/design-system/icons/check.svg?raw';
import clock from '@agrotrace/design-system/icons/clock.svg?raw';

const RULES =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
const compact = (markup: string) => markup.trim().replace(/>\s+</g, '><').replace(/\s+/g, ' ');

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
