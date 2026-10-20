import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default defineConfig((env) =>
  mergeConfig(viteConfig(env), {
    test: {
      environment: 'jsdom',
      environmentOptions: { jsdom: { url: 'http://localhost/' } },
      globalSetup: ['test/globalSetup.ts'],
      setupFiles: ['test/setup.ts'],
      include: ['test/**/*.test.{ts,tsx}'],
      css: false,
      testTimeout: 15000,
    },
  }),
);
