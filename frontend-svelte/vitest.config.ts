import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [svelte({ hot: false, compilerOptions: { runes: true } })],
  resolve: {
    conditions: ['browser'],
    alias: [
      { find: /^\$lib\//, replacement: here('./src/lib/') },
      { find: '$app/navigation', replacement: here('./test/kit/navigation.ts') },
      { find: '$app/state', replacement: here('./test/kit/state.svelte.ts') },
      { find: '$app/environment', replacement: here('./test/kit/environment.ts') },
    ],
  },
  server: { fs: { allow: [here('..')] } },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    globalSetup: ['test/globalSetup.ts'],
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    css: false,
    testTimeout: 15000,
  },
});
