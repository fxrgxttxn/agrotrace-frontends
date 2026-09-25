/**
 * The bundled contract (contracts/openapi.yaml → one JSON document): Swagger UI serves it, and the 404/405 fallback
 * reads its path templates. The build writes it to dist/openapi.json (build.mjs); CONTRACT_PATH overrides.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OpenApiDoc {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  join(HERE, 'openapi.json'), // dist/openapi.json next to the bundled main-*.js
  join(HERE, '../../contracts/dist/openapi.json'), // tsx from src/ in the repo (`pnpm --filter @agrotrace/contracts bundle`)
];

export function loadContract(path = process.env.CONTRACT_PATH): { doc: OpenApiDoc; raw: string } {
  const file = path ?? CANDIDATES.find((p) => existsSync(p));
  if (!file)
    throw new Error(`bundled contract not found (tried ${CANDIDATES.join(', ')}); set CONTRACT_PATH`);
  const raw = readFileSync(file, 'utf8');
  return { doc: JSON.parse(raw) as OpenApiDoc, raw };
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/** request path → methods the contract declares for it (upper case); [] = no such path. */
export function contractMethods(doc: OpenApiDoc, prefix = '/api/v1'): (path: string) => string[] {
  const segment = (s: string) =>
    /^\{[^/}]+\}$/.test(s) ? '[^/]+' : s.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const routes = Object.entries(doc.paths).map(([template, item]) => ({
    re: new RegExp(`^${prefix}${template.split('/').map(segment).join('/')}$`),
    methods: Object.keys(item).filter((m) => METHODS.includes(m)),
  }));
  return (path) => {
    const out = new Set<string>();
    for (const r of routes) if (r.re.test(path)) for (const m of r.methods) out.add(m.toUpperCase());
    return [...out];
  };
}
