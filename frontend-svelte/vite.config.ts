import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { writeFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const slashes = (p: string) => p.split('\\').join('/');

function moduleMap(): Plugin {
  return {
    name: 'agrotrace-module-map',
    apply: 'build',
    writeBundle(options, bundle) {
      if (!options.dir || !slashes(options.dir).endsWith('output/client')) return;
      const map: Record<string, string[]> = {};
      for (const [file, chunk] of Object.entries(bundle))
        if (chunk.type === 'chunk')
          map[`/${file}`] = Object.keys(chunk.modules).map((id) =>
            slashes(id).replace(slashes(repoRoot), ''),
          );
      writeFileSync(`${options.dir}/../module-map.json`, JSON.stringify(map, null, 1));
    },
  };
}

export default defineConfig({
  plugins: [sveltekit(), moduleMap()],
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
    proxy: { '/api': { target: process.env.API_PROXY ?? 'http://api-express:8000', changeOrigin: false } },
  },
  build: {
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
