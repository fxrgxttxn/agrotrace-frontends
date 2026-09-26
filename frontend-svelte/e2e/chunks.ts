import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The module graph of the build (Vite's manifest of the SvelteKit client build): which chunks each route node needs.
// Used to prove that the public QR pages load no chunk that only the cabinet/auth routes need (session, shell, …).

type Manifest = Record<string, { file: string; imports?: string[]; isEntry?: boolean }>;

const KIT = fileURLToPath(new URL('../.svelte-kit/', import.meta.url));
const manifest = JSON.parse(readFileSync(`${KIT}output/client/.vite/manifest.json`, 'utf8')) as Manifest;

/** Every chunk file a manifest entry imports statically (itself included). */
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
/** Source of a route node: the route file it re-exports. */
const sourceOf = (key: string) => readFileSync(`${KIT}${key.replace(/^\.svelte-kit\//, '')}`, 'utf8');

const appNodes = NODES.filter((k) => sourceOf(k).includes('src/routes/(app)/'));
const publicNodes = NODES.filter((k) => sourceOf(k).includes('src/routes/(public)/'));
const rootNodes = NODES.filter((k) =>
  /src\/routes\/\+layout|kit\/src\/runtime\/components/.test(sourceOf(k)),
);
const entries = Object.keys(manifest).filter((k) => manifest[k]!.isEntry && !NODES.includes(k));

/** Chunks needed only by the cabinet and auth routes (not by the public pages, the root layout or the kit entries). */
export const cabinetOnly: Set<string> = (() => {
  const shared = closure([...publicNodes, ...rootNodes, ...entries]);
  return new Set([...closure(appNodes)].filter((f) => !shared.has(f)));
})();

export const nodeCounts = { app: appNodes.length, public: publicNodes.length, root: rootNodes.length };

/** Source modules of every chunk (written by the build: vite.config.ts `moduleMap`). */
const modules = JSON.parse(readFileSync(`${KIT}output/module-map.json`, 'utf8')) as Record<string, string[]>;

/** Every source module the public pages can run: their nodes, the root layout and the kit entries, with all their
 * static imports. Checked directly (not against a cabinet set derived from the same graph). */
export const publicModules: string[] = [...closure([...publicNodes, ...rootNodes, ...entries])].flatMap(
  (f) => modules[f] ?? [],
);

/** Modules that belong to the cabinet: never in the public graph. */
export const CABINET_MODULE =
  /frontend-svelte\/src\/(lib\/(app\/(session|live|guards|forms|cache)|shell\/|pages\/)|routes\/\(app\)\/)/;

/** The client chunk of a route node, by its route file (e.g. `src/routes/(app)/(cabinet)/fields/+page.svelte`). */
export function nodeFile(routeFile: string): string {
  const key = NODES.find((k) => sourceOf(k).includes(`"../../../../${routeFile}"`));
  if (!key) throw new Error(`no route node for ${routeFile}`);
  return `/${manifest[key]!.file}`;
}

/** The kit's start-up entry chunks (`start`, `app`), which the boot script imports. */
export const entryFiles: string[] = entries.map((k) => `/${manifest[k]!.file}`);
