// Regenerates tests/Fixtures/jpeg: truncated variants of three JPEGs (baseline and progressive, written by sharp, plus
// the tests/api portrait fixture) and verdicts.json — what Express's raster pipeline (sharp, failOn 'error': metadata,
// then rotate/resize/webp, every upload a fresh buffer) answers for each:
// - `accepted`: sharp's verdict with sharp.concurrency(1) — deterministic, and what Laravel must answer;
// - `acceptedOf20`: how often sharp accepts it in 20 tries at its default concurrency (Express's setting). For a
//   baseline JPEG cut near its end this is a thread race inside libvips (re-review N1): the truncation is found or
//   not depending on which thread gets there first, so Express accepts such a file only some of the time.
// Run in the tools container from the repo root:
//   docker compose run --rm --no-deps tools node backend-laravel/tests/Fixtures/jpeg/generate.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(new URL('../../../../backend-express/package.json', import.meta.url));
const sharp = require('sharp');
sharp.cache(false); // every upload is a fresh buffer: no decode may be answered from the libvips operation cache
const defaultConcurrency = sharp.concurrency();
const dir = new URL('./', import.meta.url);
const INPUT = { limitInputPixels: 40_000_000, failOn: 'error' };

async function accepted(bytes) {
  try {
    const meta = await sharp(bytes, INPUT).metadata();
    if (meta.format !== 'jpeg' || !meta.width || !meta.height) return false;
    for (const size of [96, 480])
      await sharp(bytes, INPUT).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    return true;
  } catch {
    return false;
  }
}

// A deterministic gradient with detail, so the entropy-coded data is long enough to cut into.
const w = 320, h = 200;
const raw = Buffer.alloc(w * h * 3);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    raw[i] = (x * 7 + y * 3) & 255;
    raw[i + 1] = ((x ^ y) * 5) & 255;
    raw[i + 2] = (x * y) & 255;
  }
const img = () => sharp(raw, { raw: { width: w, height: h, channels: 3 } });
const sources = {
  baseline: await img().jpeg({ quality: 85 }).toBuffer(),
  progressive: await img().jpeg({ quality: 85, progressive: true }).toBuffer(),
  portrait: readFileSync(new URL('../../../../tests/api/fixtures/portrait-300x600.jpg', import.meta.url)),
};
const cuts = { full: 0, noEoi: 2, cut10: 10, cut40: 40, cut41: 41, cut100: 100, cut300: 300, half: 'half' };
const verdicts = {};
for (const [name, src] of Object.entries(sources)) {
  writeFileSync(new URL(`${name}.jpg`, dir), src);
  for (const [cut, n] of Object.entries(cuts)) {
    const len = n === 'half' ? Math.floor(src.length / 2) : src.length - n;
    const bytes = () => Buffer.from(src.subarray(0, len));
    sharp.concurrency(1);
    const one = await accepted(bytes());
    sharp.concurrency(defaultConcurrency);
    let ok = 0;
    for (let i = 0; i < 20; i++) if (await accepted(bytes())) ok++;
    verdicts[`${name}:${cut}`] = { length: len, accepted: one, acceptedOf20: ok };
  }
}
writeFileSync(new URL('verdicts.json', dir), `${JSON.stringify(verdicts, null, 2)}\n`);
console.log(JSON.stringify(verdicts));
