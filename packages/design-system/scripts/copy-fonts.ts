import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fontsDir = join(root, 'fonts');
const SUBSETS = ['cyrillic', 'latin'] as const;

const FAMILIES: { pkg: string; weights: number[] }[] = [
  { pkg: 'geologica', weights: [600, 700] },
  { pkg: 'onest', weights: [400, 500, 600] },
  { pkg: 'jetbrains-mono', weights: [400, 500] },
];

rmSync(fontsDir, { recursive: true, force: true });
mkdirSync(fontsDir);

const faces: string[] = [];
for (const { pkg, weights } of FAMILIES) {
  const src = join(root, 'node_modules', '@fontsource', pkg);
  const meta = JSON.parse(readFileSync(join(src, 'metadata.json'), 'utf8')) as { family: string };
  const ranges = JSON.parse(readFileSync(join(src, 'unicode.json'), 'utf8')) as Record<string, string>;
  const available = new Set(readdirSync(join(src, 'files')));
  for (const weight of weights) {
    for (const subset of SUBSETS) {
      const file = `${pkg}-${subset}-${weight}-normal.woff2`;
      if (!available.has(file)) throw new Error(`missing ${file} in @fontsource/${pkg}`);
      const range = ranges[subset];
      if (!range) throw new Error(`missing unicode-range for ${subset} in @fontsource/${pkg}`);
      copyFileSync(join(src, 'files', file), join(fontsDir, file));
      faces.push(
        [
          '@font-face {',
          `  font-family: '${meta.family}';`,
          '  font-style: normal;',
          `  font-weight: ${weight};`,
          '  font-display: swap;',
          `  src: url('./fonts/${file}') format('woff2');`,
          `  unicode-range: ${range};`,
          '}',
        ].join('\n'),
      );
    }
  }
}

writeFileSync(
  join(root, 'fonts.css'),
  `${faces.join('\n')}\n`,
);
console.log(`copied ${faces.length} font files`);
