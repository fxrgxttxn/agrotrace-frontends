const RULES =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';

const compact = (markup: string) => markup.trim().replace(/>\s+</g, '><').replace(/\s+/g, ' ');

export function symbolOf(name: string, raw: string): string {
  const body = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(raw)?.[1] ?? '';
  return `<symbol id="i-${name}" ${RULES}>${compact(body)}</symbol>`;
}

export function injectIcons(icons: Record<string, string>, doc: Document = document): void {
  if (doc.getElementById('at-sprite')) return;
  const tpl = doc.createElement('template');
  tpl.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position: absolute; width: 0; height: 0; overflow: hidden">' +
    Object.entries(icons)
      .map(([name, raw]) => symbolOf(name, raw))
      .join('') +
    '</svg>';
  const svg = tpl.content.firstElementChild!;
  svg.id = 'at-sprite';
  doc.body.prepend(svg);
}
