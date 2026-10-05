import sprite from '@agrotrace/design-system/sprite.svg' with { loader: 'text' };

export function injectSprite(doc: Document = document): void {
  if (doc.getElementById('at-sprite')) return;
  const svg = new DOMParser().parseFromString(sprite.trim(), 'image/svg+xml').documentElement;
  if (svg.nodeName !== 'svg') return;
  svg.id = 'at-sprite';
  doc.body.prepend(doc.importNode(svg, true));
}
