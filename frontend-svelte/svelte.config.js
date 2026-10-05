import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { writeTemplates } from './scripts/templates.mjs';

const mock = process.env.AGROTRACE_MOCK === '1';
const out = mock ? 'build-mock' : 'build';

export default {
  preprocess: vitePreprocess(),
  compilerOptions: { runes: true },
  kit: {
    adapter: adapter({ pages: out, assets: out, fallback: 'index.html', strict: true }),
    appDir: 'assets',
    paths: { relative: false },
    version: { pollInterval: 0 },
    output: { preloadStrategy: 'modulepreload' },
    files: { ...writeTemplates(), ...(mock ? { assets: '../packages/mock-api/public' } : {}) },
    ...(mock ? { outDir: '.svelte-kit-mock' } : {}),
  },
};
