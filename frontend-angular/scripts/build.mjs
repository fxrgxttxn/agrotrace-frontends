import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mock = process.argv.includes('--mock');
const dist = join(root, mock ? 'dist-mock' : 'dist');
const pub = join(root, 'dist-public');
const ng = (...args) => execFileSync('ng', args, { cwd: root, stdio: 'inherit' });

rmSync(pub, { recursive: true, force: true });
ng('build', 'agrotrace-public', '--stats-json');
const stats = JSON.parse(readFileSync(join(pub, 'stats.json'), 'utf8'));
const main = Object.entries(stats.outputs).find(([, o]) =>
  /(^|\/)src\/public\/main\.ts$/.test(o.entryPoint ?? ''),
)?.[0];
if (!main) throw new Error('build: the public build has no main file');
writeFileSync(
  join(root, 'src/public-entry.build.ts'),
  `const url = '/assets/p/${main}';\n` +
    `export const loadPublic = (): Promise<unknown> => import(/* @vite-ignore */ url);\n`,
);
ng('build', 'agrotrace', '-c', mock ? 'production,mock' : 'production', '--stats-json');
execFileSync('node', [join(root, 'scripts/postbuild.mjs'), ...(mock ? ['--mock'] : [])], {
  stdio: 'inherit',
});
mkdirSync(join(dist, 'assets/p'), { recursive: true });
for (const f of readdirSync(pub)) if (f.endsWith('.js')) cpSync(join(pub, f), join(dist, 'assets/p', f));
execFileSync('node', [join(root, 'scripts/public-budget.mjs'), ...(mock ? ['--mock'] : [])], {
  stdio: 'inherit',
});
