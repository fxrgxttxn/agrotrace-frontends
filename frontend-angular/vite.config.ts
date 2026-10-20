import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import angular from '@analogjs/vite-plugin-angular';
import type { Plugin } from 'vite';
type PluginOption = NonNullable<
  Parameters<typeof defineConfig>[0] extends infer C ? (C extends { plugins?: infer P } ? P : never) : never
>;
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** `.svg` imports are text, as in the build (angular.json `loader`). */
function svgText(): Plugin {
  return {
    name: 'agrotrace-svg-text',
    enforce: 'pre',
    load(id) {
      const file = id.split('?', 1)[0]!;
      if (!file.endsWith('.svg')) return null;
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
    },
  };
}

// Component tests only (the app itself is built by the Angular CLI): Vitest + @analogjs/vite-plugin-angular (spec
// §9.2) + Angular Testing Library, MSW handlers generated from the contract examples (test/msw/fromContract.ts).
export default defineConfig({
  // The plugins are typed against the workspace's `vite`, Vitest against its own copy of the same major: one plugin list.
  plugins: [angular({ tsconfig: 'tsconfig.spec.json' }), svgText()] as unknown as PluginOption,
  server: { fs: { allow: [repoRoot] } },
  test: {
    globals: true,
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    globalSetup: ['test/globalSetup.ts'],
    setupFiles: ['test/polyfills.ts', 'test/setup.ts'],
    include: ['test/**/*.test.ts'],
    css: false,
    testTimeout: 15000,
    reporters: ['default'],
    // One process per test file: BroadcastChannel (the cross-tab logout) must not reach the apps of other files, as it
    // would between worker threads of one process.
    pool: 'forks',
  },
});
