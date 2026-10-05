import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const PKG = new URL('../', import.meta.url);
const SEED = new URL('../../../db/seed/', import.meta.url);
const OUT = new URL('assets/', PKG);
const requireSeed = createRequire(new URL('package.json', SEED));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharp = requireSeed('sharp') as (input: Buffer) => any;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const read = (u: URL): Buffer => readFileSync(u);

interface Products {
  key: string;
  image: string;
}
const products = JSON.parse(read(new URL('data/products.json', SEED)).toString('utf8')) as Products[];
const organizations = JSON.parse(read(new URL('data/organizations.json', SEED)).toString('utf8')) as {
  key: string;
}[];
const users = JSON.parse(read(new URL('data/users.json', SEED)).toString('utf8')) as { avatar?: string }[];

const imports: string[] = [];
let n = 0;
const importOf = (rel: string): string => {
  const name = `a${n++}`;
  imports.push(`import ${name} from '${rel}';`);
  return name;
};

interface VariantEntry {
  url: string;
  sha256: string;
  size: number;
}

async function raster(dir: 'products' | 'avatars', file: string): Promise<string> {
  const original = read(new URL(`images/${dir}/${file}`, SEED));
  const base = file.replace(/\.[a-z]+$/, '');
  mkdirSync(new URL(`seed/${dir}/`, OUT), { recursive: true });
  const variants: Record<string, VariantEntry> = {};
  const parts: string[] = [];
  for (const size of [96, 480]) {
    const body = await sharp(original)
      .rotate()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    const rel = `seed/${dir}/${base}-${size}.webp`;
    writeFileSync(new URL(rel, OUT), body);
    const binding = importOf(`../../assets/${rel}`);
    variants[size] = { url: binding, sha256: sha256(body), size: body.length };
    parts.push(`${size}: { url: ${binding}, sha256: '${sha256(body)}', size: ${body.length} }`);
  }
  return `{ mime: 'image/jpeg', size: ${original.length}, sha256: '${sha256(original)}', variants: { ${parts.join(', ')} } }`;
}

const productLines: string[] = [];
for (const p of products) productLines.push(`  '${p.image}': ${await raster('products', p.image)},`);

const avatarLines: string[] = [];
for (const name of [...new Set(users.flatMap((u) => (u.avatar ? [u.avatar] : [])))].sort())
  avatarLines.push(`  '${name}': ${await raster('avatars', `${name}.jpg`)},`);

const logoLines: string[] = [];
for (const o of organizations) {
  const svg = read(new URL(`images/logos/${o.key}.svg`, SEED));
  const binding = importOf(`@agrotrace/seed/images/logos/${o.key}.svg`);
  logoLines.push(`  '${o.key}': { url: ${binding}, sha256: '${sha256(svg)}', size: ${svg.length} },`);
}

function woffToTtf(woff: Buffer): Buffer {
  if (woff.toString('latin1', 0, 4) !== 'wOFF') throw new Error('not a WOFF file');
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables: { tag: string; checksum: number; data: Buffer }[] = [];
  for (let i = 0; i < numTables; i++) {
    const e = 44 + i * 20;
    const tag = woff.toString('latin1', e, e + 4);
    const offset = woff.readUInt32BE(e + 4);
    const compLength = woff.readUInt32BE(e + 8);
    const origLength = woff.readUInt32BE(e + 12);
    const checksum = woff.readUInt32BE(e + 16);
    const raw = woff.subarray(offset, offset + compLength);
    tables.push({ tag, checksum, data: compLength < origLength ? inflateSync(raw) : Buffer.from(raw) });
  }
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= numTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  const header = Buffer.alloc(12 + numTables * 16);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(numTables * 16 - searchRange, 10);
  const bodies: Buffer[] = [];
  let offset = header.length;
  tables.forEach((t, i) => {
    const e = 12 + i * 16;
    header.write(t.tag, e, 'latin1');
    header.writeUInt32BE(t.checksum, e + 4);
    header.writeUInt32BE(offset, e + 8);
    header.writeUInt32BE(t.data.length, e + 12);
    const padded = Buffer.alloc((t.data.length + 3) & ~3);
    t.data.copy(padded);
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([header, ...bodies]);
}

const FONTS: [string, string, string][] = [
  ['regular-lat', '@fontsource/onest', 'onest-latin-400-normal'],
  ['regular-cyr', '@fontsource/onest', 'onest-cyrillic-400-normal'],
  ['bold-lat', '@fontsource/onest', 'onest-latin-600-normal'],
  ['bold-cyr', '@fontsource/onest', 'onest-cyrillic-600-normal'],
  ['mono-lat', '@fontsource/jetbrains-mono', 'jetbrains-mono-latin-500-normal'],
  ['mono-cyr', '@fontsource/jetbrains-mono', 'jetbrains-mono-cyrillic-500-normal'],
];
mkdirSync(new URL('fonts/', OUT), { recursive: true });
const fontLines: string[] = [];
for (const [key, pkg, file] of FONTS) {
  const woff = readFileSync(requireSeed.resolve(`${pkg}/files/${file}.woff`));
  writeFileSync(new URL(`fonts/${file}.ttf`, OUT), woffToTtf(woff));
  fontLines.push(`  '${key}': ${importOf(`../../assets/fonts/${file}.ttf`)},`);
}

const manifest = [
  ...imports,
  "import type { SeedImages } from './assets.js';",
  '',
  'export const SEED_IMAGES: SeedImages = {',
  '  products: {',
  ...productLines.map((l) => `  ${l}`),
  '  },',
  '  avatars: {',
  ...avatarLines.map((l) => `  ${l}`),
  '  },',
  '  logos: {',
  ...logoLines.map((l) => `  ${l}`),
  '  },',
  '};',
  '',
  'export const PDF_FONTS: Record<string, string> = {',
  ...fontLines,
  '};',
  '',
].join('\n');
writeFileSync(fileURLToPath(new URL('src/seed/assets.generated.ts', PKG)), manifest);
console.log(`assets: ${productLines.length} products, ${avatarLines.length} avatars, ${logoLines.length} logos, ${fontLines.length} fonts`);
