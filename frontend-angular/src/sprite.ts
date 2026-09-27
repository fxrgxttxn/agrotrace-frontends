// Always text, also in the mock build whose default `.svg` loader is `file` (the mock's organization logos are URLs).
import sprite from '@agrotrace/design-system/sprite.svg' with { loader: 'text' };

/** Puts the icon sprite once, as the first child of <body> (README «Иконки»). Parsed as SVG, not through Angular. */
export function injectSprite(doc: Document = document): void {
  if (doc.getElementById('at-sprite')) return;
  const svg = new DOMParser().parseFromString(sprite.trim(), 'image/svg+xml').documentElement;
  if (svg.nodeName !== 'svg') return;
  svg.id = 'at-sprite';
  doc.body.prepend(doc.importNode(svg, true));
}
