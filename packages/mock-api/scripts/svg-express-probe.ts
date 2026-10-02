/**
 * Records what Express does with each SVG probe document (test/svg-cases.ts) into test/fixtures/svg-express.json:
 * backend-express's own decode → `scanSvg` → `sanitizeSvgText` (the worker's job), in process.
 *
 *   docker compose run --rm -w /repo/backend-express tools pnpm exec tsx ../packages/mock-api/scripts/svg-express-probe.ts
 */
import { writeFileSync } from 'node:fs';
import { scanSvg } from '../../../backend-express/src/infra/svg.js';
import { sanitizeSvgText } from '../../../backend-express/src/infra/svg-sanitize.js';
import { SVG_CASES } from '../test/svg-cases.js';

const out: Record<string, { ok: false; tooComplex: boolean } | { ok: true; svg: string }> = {};
for (const [name, doc] of Object.entries(SVG_CASES)) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(doc));
  } catch {
    out[name] = { ok: false, tooComplex: false };
    continue;
  }
  const scan = scanSvg(text);
  if (!scan.ok) {
    out[name] = { ok: false, tooComplex: scan.tooComplex };
    continue;
  }
  const svg = sanitizeSvgText(text);
  out[name] = svg === null ? { ok: false, tooComplex: false } : { ok: true, svg };
}
writeFileSync(new URL('../test/fixtures/svg-express.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`${Object.keys(out).length} cases recorded`);
