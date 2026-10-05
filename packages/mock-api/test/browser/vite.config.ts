import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  build: { outDir: process.env.OUT_DIR ?? '/tmp/mock-api-check', emptyOutDir: true, assetsInlineLimit: 0 },
  server: { fs: { allow: [fileURLToPath(new URL('../../../..', import.meta.url))] } },
});
