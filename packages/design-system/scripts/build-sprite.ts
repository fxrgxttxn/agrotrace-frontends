import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RULES =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';

export function compact(markup: string): string {
  return markup.trim().replace(/>\s+</g, '><').replace(/\s+/g, ' ');
}

export function buildSprite(root: string): string {
  const names = JSON.parse(readFileSync(join(root, 'icons', 'manifest.json'), 'utf8')) as string[];
  const symbols = names.map((name) => {
    const src = readFileSync(join(root, 'icons', `${name}.svg`), 'utf8');
    const body = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(src)?.[1];
    if (body === undefined) throw new Error(`icons/${name}.svg: no <svg> root`);
    return `  <symbol id="i-${name}" ${RULES}>${compact(body)}</symbol>\n`;
  });
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position: absolute; width: 0; height: 0; overflow: hidden">\n' +
    symbols.join('') +
    '</svg>\n'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  writeFileSync(join(root, 'sprite.svg'), buildSprite(root));
}
