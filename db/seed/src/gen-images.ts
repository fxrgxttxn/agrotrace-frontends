import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { loadData, SEED_ROOT } from './data.js';
import { AVATARS, avatarSvg, logoSvg } from './images.js';

const data = loadData();
for (const o of data.organizations) {
  writeFileSync(new URL(`images/logos/${o.key}.svg`, SEED_ROOT), logoSvg(o.name));
}
for (const name of Object.keys(AVATARS)) {
  const jpg = await sharp(Buffer.from(avatarSvg(name)))
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  writeFileSync(new URL(`images/avatars/${name}.jpg`, SEED_ROOT), jpg);
}
console.log(`logos: ${data.organizations.length}, avatars: ${Object.keys(AVATARS).length}`);
