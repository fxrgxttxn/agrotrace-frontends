import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Builds the browser check page (test/browser) with the package's public/mockServiceWorker.js.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  build: { outDir: process.env.OUT_DIR ?? '/tmp/mock-api-check', emptyOutDir: true, assetsInlineLimit: 0 },
  server: { fs: { allow: [fileURLToPath(new URL('../../../..', import.meta.url))] } },
});
