import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { bootFallback, bootTexts } from './vite-plugins/bootFallback';
import { publicBudget } from './vite-plugins/publicBudget';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const BOOT = bootTexts(JSON.parse(readFileSync(`${repoRoot}packages/i18n/locales/ru.json`, 'utf8')));

process.env.VITE_YANDEX_MAPS_API_KEY ??= process.env.YANDEX_MAPS_API_KEY ?? '';

export default defineConfig(({ mode }) => {
  const mock = mode === 'mock';
  return {
    plugins: [react(), bootFallback(BOOT), publicBudget()],
    define: { __AT_BOOT_TEXTS__: JSON.stringify(BOOT) },
    publicDir: mock ? fileURLToPath(new URL('../packages/mock-api/public', import.meta.url)) : false,
    server: {
      port: 5173,
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
