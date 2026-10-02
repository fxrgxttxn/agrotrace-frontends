import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Yandex Maps key (ruling F11): `YANDEX_MAPS_API_KEY` of .env (the tools container reads .env) reaches the build as
// `VITE_YANDEX_MAPS_API_KEY` (Vite exposes VITE_* of the environment); an explicit VITE_ value wins.
process.env.VITE_YANDEX_MAPS_API_KEY ??= process.env.YANDEX_MAPS_API_KEY ?? '';

// Static SPA served by the gateway (/srv/react). The gateway CSP is `script-src 'self'`: the build must emit no inline
// script (index.html only references the hashed entry; the module-preload polyfill, which would be bundled, is off —
// every supported browser has native modulepreload).
// `--mode mock` (ruling FM23): the same app with the in-browser backend of @agrotrace/mock-api, built into dist-mock
// with the package's unpatched MSW worker (`/mockServiceWorker.js`) as the only public file; gateway-react serves it
// at react-mock.localhost.
export default defineConfig(({ mode }) => {
  const mock = mode === 'mock';
  return {
    plugins: [react()],
    publicDir: mock ? fileURLToPath(new URL('../packages/mock-api/public', import.meta.url)) : false,
    server: {
      port: 5173,
      // @agrotrace/domain imports contract JSON (contracts/rules/*.json) and the design system lives in packages/ —
      // both outside this package (R89 note).
      fs: { allow: [repoRoot] },
      proxy: mock
        ? undefined
        : { '/api': { target: process.env.API_PROXY ?? 'http://api-express:8000', changeOrigin: false } },
    },
    build: {
      outDir: mock ? 'dist-mock' : 'dist',
      emptyOutDir: true,
      modulePreload: { polyfill: false },
      assetsInlineLimit: 0,
      sourcemap: false,
    },
  };
});
