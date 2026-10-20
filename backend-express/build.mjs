// Production build: esbuild bundles the three entrypoints with the workspace packages (@agrotrace/domain,
// @agrotrace/validation — TypeScript sources) into dist/*.js; npm dependencies stay external (node_modules of the
// image). The contract is bundled into dist/openapi.json for Swagger UI and the 404/405 fallback.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { bundle, loadConfig } from '@redocly/openapi-core';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@agrotrace/'));

rmSync(`${root}dist`, { recursive: true, force: true });
mkdirSync(`${root}dist`, { recursive: true });

await build({
  entryPoints: [
    ...['main-api', 'main-worker', 'main-scheduler'].map((n) => ({ in: `${root}src/${n}.ts`, out: n })),
    // P15: the SVG sanitizer's worker thread (src/infra/svg.ts loads dist/svg-worker.js next to the bundle).
    { in: `${root}src/infra/svg-worker.ts`, out: 'svg-worker' },
  ],
  outdir: `${root}dist`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  // Bundled CommonJS (none expected, but cheap insurance) may call require().
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});

const contracts = fileURLToPath(new URL('../contracts/', import.meta.url));
const config = await loadConfig({ configPath: `${contracts}redocly.yaml` });
const result = await bundle({ ref: `${contracts}openapi.yaml`, config });
writeFileSync(`${root}dist/openapi.json`, JSON.stringify(result.bundle.parsed, null, 2));
console.log('dist/openapi.json written');
