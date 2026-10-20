import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Static SPA served by the gateway (/srv/react). The gateway CSP is `script-src 'self'`: the build must emit no inline
// script (index.html only references the hashed entry; the module-preload polyfill, which would be bundled, is off —
// every supported browser has native modulepreload).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // @agrotrace/domain imports contract JSON (contracts/rules/*.json) and the design system lives in packages/ —
    // both outside this package (R89 note).
    fs: { allow: [repoRoot] },
    proxy: { '/api': { target: process.env.API_PROXY ?? 'http://api-express:8000', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
