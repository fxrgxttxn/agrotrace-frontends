import sprite from '@agrotrace/design-system/sprite.svg';

/** Puts the icon sprite once, as the first child of <body> (README «Иконки»). Parsed as SVG, not through Angular. */
export function injectSprite(doc: Document = document): void {
  if (doc.getElementById('at-sprite')) return;
  const svg = new DOMParser().parseFromString(sprite.trim(), 'image/svg+xml').documentElement;
  if (svg.nodeName !== 'svg') return;
  svg.id = 'at-sprite';
  doc.body.prepend(doc.importNode(svg, true));
}
