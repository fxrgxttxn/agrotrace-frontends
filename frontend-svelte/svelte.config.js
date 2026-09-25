import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Static SPA served by the gateway (/srv/svelte): adapter-static with the SPA fallback `index.html` (every route is
// client-rendered: `ssr = false` in src/routes/+layout.ts). The gateway CSP is `script-src 'self'`: SvelteKit's
// inline start-up script is moved into an external file after the build (scripts/csp-bootstrap.mjs).
/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  compilerOptions: { runes: true },
  kit: {
    adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', strict: true }),
    // Hashed build output under /assets/ (the gateway caches /assets/* for a year, immutable).
    appDir: 'assets',
    // The fallback page answers every deep URL (/fields/123): asset paths must be absolute.
    paths: { relative: false },
    // No automatic version polling (index.html is never cached by the gateway).
    version: { pollInterval: 0 },
    output: { preloadStrategy: 'modulepreload' },
  },
};
