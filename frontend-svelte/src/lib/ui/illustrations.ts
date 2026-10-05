const FILES = import.meta.glob('../../../../packages/design-system/illustrations/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export type IllustrationName =
  | 'empty-fields'
  | 'empty-batches'
  | 'empty-waybills'
  | 'empty-lab'
  | 'empty-recalls'
  | 'empty-complaints'
  | 'empty-notifications'
  | 'empty-search'
  | 'not-found'
  | 'forbidden'
  | 'login'
  | 'recall-warning';

export const ILLUSTRATIONS: readonly IllustrationName[] = [
  'empty-fields',
  'empty-batches',
  'empty-waybills',
  'empty-lab',
  'empty-recalls',
  'empty-complaints',
  'empty-notifications',
  'empty-search',
  'not-found',
  'forbidden',
  'login',
  'recall-warning',
];

interface Parsed {
  viewBox: string;
  inner: string;
}

const PARSED = new Map<string, Parsed>();
for (const [path, raw] of Object.entries(FILES)) {
  const name = /([a-z-]+)\.svg$/.exec(path)?.[1];
  const m = /^\s*<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(raw);
  if (name && m) PARSED.set(name, { viewBox: m[1]!, inner: m[2]!.trim() });
}

export function illustration(name: IllustrationName): Parsed {
  const art = PARSED.get(name);
  if (!art) throw new Error(`Unknown illustration: ${name}`);
  return art;
}

export function illustrationMarkup(name: IllustrationName): string {
  return illustration(name).inner;
}
