import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { writeTemplates } from './scripts/templates.mjs';

// Mock mode (ruling FM23, `AGROTRACE_MOCK=1 vite build --mode mock`, ./at.sh fe:build svelte --mock): the same app with
// the in-browser backend of @agrotrace/mock-api (started by the `init` hook of src/hooks.client.ts), built into build-mock
// with its own SvelteKit output directory (the production build and its module map stay untouched) and the package's
// unpatched MSW worker (`/mockServiceWorker.js`) as the only static file; gateway-svelte serves it at
// svelte-mock.localhost.
const mock = process.env.AGROTRACE_MOCK === '1';
const out = mock ? 'build-mock' : 'build';

// Static SPA served by the gateway (/srv/svelte): adapter-static with the SPA fallback `index.html` (every route is
// client-rendered: `ssr = false` in src/routes/+layout.ts). The gateway CSP is `script-src 'self'`: SvelteKit's
// inline start-up script is moved into an external file after the build (scripts/csp-bootstrap.mjs).
/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  compilerOptions: { runes: true },
  kit: {
    adapter: adapter({ pages: out, assets: out, fallback: 'index.html', strict: true }),
    // Hashed build output under /assets/ (the gateway caches /assets/* for a year, immutable).
    appDir: 'assets',
    // The fallback page answers every deep URL (/fields/123): asset paths must be absolute.
    paths: { relative: false },
    // No automatic version polling (index.html is never cached by the gateway).
    version: { pollInterval: 0 },
    output: { preloadStrategy: 'modulepreload' },
    // index.html and the error page carry the static FM18 screen, its texts from @agrotrace/i18n (scripts/templates.mjs).
    files: { ...writeTemplates(), ...(mock ? { assets: '../packages/mock-api/public' } : {}) },
    ...(mock ? { outDir: '.svelte-kit-mock' } : {}),
  },
};
