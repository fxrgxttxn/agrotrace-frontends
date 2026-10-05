import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Manifest = Record<string, { file: string; imports?: string[]; isEntry?: boolean }>;

const KIT = fileURLToPath(new URL('../.svelte-kit/', import.meta.url));
const manifest = JSON.parse(readFileSync(`${KIT}output/client/.vite/manifest.json`, 'utf8')) as Manifest;

function closure(keys: string[]): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    const e = manifest[k];
    if (!e) return;
    out.add(`/${e.file}`);
    for (const i of e.imports ?? []) walk(i);
  };
  keys.forEach(walk);
  return out;
}

const NODES = Object.keys(manifest).filter((k) => /generated\/client-optimized\/nodes\/\d+\.js$/.test(k));
const sourceOf = (key: string) => readFileSync(`${KIT}${key.replace(/^\.svelte-kit\//, '')}`, 'utf8');

const appNodes = NODES.filter((k) => sourceOf(k).includes('src/routes/(app)/'));
const publicNodes = NODES.filter((k) => sourceOf(k).includes('src/routes/(public)/'));
const rootNodes = NODES.filter((k) =>
  /src\/routes\/\+layout|kit\/src\/runtime\/components/.test(sourceOf(k)),
);
const entries = Object.keys(manifest).filter((k) => manifest[k]!.isEntry && !NODES.includes(k));

export const cabinetOnly: Set<string> = (() => {
  const shared = closure([...publicNodes, ...rootNodes, ...entries]);
  return new Set([...closure(appNodes)].filter((f) => !shared.has(f)));
})();

export const nodeCounts = { app: appNodes.length, public: publicNodes.length, root: rootNodes.length };

const modules = JSON.parse(readFileSync(`${KIT}output/module-map.json`, 'utf8')) as Record<string, string[]>;

export const publicModules: string[] = [...closure([...publicNodes, ...rootNodes, ...entries])].flatMap(
  (f) => modules[f] ?? [],
);

export const CABINET_MODULE =
  /frontend-svelte\/src\/(lib\/(app\/(session|live|guards|forms|cache)|shell\/|pages\/)|routes\/\(app\)\/)/;

export const PUBLIC_ALLOWED: RegExp[] = [
  /^frontend-svelte\/src\/routes\/\+(layout\.ts|layout\.svelte|error\.svelte)$/,
  /^frontend-svelte\/src\/routes\/\(public\)\//,
  /^frontend-svelte\/src\/lib\/public\//,
  /^frontend-svelte\/src\/lib\/app\/(theme\.svelte|sprite|chunkFailure)\.ts$/,
  /^frontend-svelte\/src\/hooks\.client\.ts$/,
  /^frontend-svelte\/src\/lib\/ui\/(Button|Icon|Field|Input|Textarea|Avatar|CardBody|CardFacts|CardHeader|Timeline)\.svelte$/,
  /^frontend-svelte\/src\/lib\/ui\/(field|display)\.ts$/,
  /^packages\/api-client\/src\/(public|problem|variant)\.ts$/,
  /^packages\/(i18n|design-system)\//,
  /^frontend-svelte\/\.svelte-kit\/generated\//,
  /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(svelte|@sveltejs\/kit|esm-env|devalue|clsx|cookie|set-cookie-parser)\//,
  /^\0|^vite\//,
];

export const publicNotAllowed = (): string[] =>
  publicModules.filter((m) => !PUBLIC_ALLOWED.some((re) => re.test(m.split('?')[0]!)));

export function nodeFile(routeFile: string): string {
  const key = NODES.find((k) => sourceOf(k).includes(`"../../../../${routeFile}"`));
  if (!key) throw new Error(`no route node for ${routeFile}`);
  return `/${manifest[key]!.file}`;
}

export const entryFiles: string[] = entries.map((k) => `/${manifest[k]!.file}`);

export function chunkWith(module: RegExp): string {
  const file = Object.entries(modules).find(([, list]) => list.some((m) => module.test(m)))?.[0];
  if (!file) throw new Error(`no chunk holds ${module}`);
  return file.startsWith('/') ? file : `/${file}`;
}
