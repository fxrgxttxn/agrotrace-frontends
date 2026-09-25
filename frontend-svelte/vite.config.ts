import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// SvelteKit SPA (adapter-static, ssr off). The gateway CSP is `script-src 'self'`: no module-preload polyfill (every
// supported browser has native modulepreload), no inlined assets, no source maps in the production build.
export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5173,
    // @agrotrace/domain imports contract JSON (contracts/rules/*.json) and the design system lives in packages/ —
    // both outside this package (R89 note).
    fs: { allow: [repoRoot] },
    proxy: { '/api': { target: process.env.API_PROXY ?? 'http://api-express:8000', changeOrigin: false } },
  },
  build: {
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
