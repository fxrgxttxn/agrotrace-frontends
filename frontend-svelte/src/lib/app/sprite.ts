import sprite from '@agrotrace/design-system/sprite.svg?raw';

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
