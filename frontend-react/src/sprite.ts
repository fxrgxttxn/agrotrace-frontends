import sprite from '@agrotrace/design-system/sprite.svg?raw';

/** Puts the icon sprite once, as the first child of <body> (README «Иконки»). */
export function injectSprite(doc: Document = document): void {
  if (doc.getElementById('at-sprite')) return;
  const tpl = doc.createElement('template');
  tpl.innerHTML = sprite.trim();
  const svg = tpl.content.firstElementChild;
  if (!svg) return;
  svg.id = 'at-sprite';
  doc.body.prepend(svg);
}
