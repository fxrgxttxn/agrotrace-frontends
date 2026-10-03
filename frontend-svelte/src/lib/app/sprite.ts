import sprite from '@agrotrace/design-system/sprite.svg?raw';

/** Puts the icon sprite once, as the first child of <body> (README «Иконки»); the small sprite of a public QR page
 * (`data-subset`, lib/public/sprite.ts) is replaced by the whole one. */
export function injectSprite(doc: Document = document): void {
  const existing = doc.getElementById('at-sprite');
  if (existing && !existing.hasAttribute('data-subset')) return;
  const tpl = doc.createElement('template');
  tpl.innerHTML = sprite.trim();
  const svg = tpl.content.firstElementChild;
  if (!svg) return;
  existing?.remove();
  svg.id = 'at-sprite';
  doc.body.prepend(svg);
}
