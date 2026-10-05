import sprite from '@agrotrace/design-system/sprite.svg?raw';

export function injectSprite(doc: Document = document): void {
  if (doc.getElementById('at-sprite')) return;
  const tpl = doc.createElement('template');
  tpl.innerHTML = sprite.trim();
  const svg = tpl.content.firstElementChild;
  if (!svg) return;
  svg.id = 'at-sprite';
  doc.body.prepend(svg);
}
