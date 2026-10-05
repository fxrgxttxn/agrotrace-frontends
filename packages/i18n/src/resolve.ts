type Json = Record<string, unknown> | string;

export function resolve(dict: object, key: string): string | undefined {
  const dot = key.indexOf('.');
  if (dot === -1) {
    const value = (dict as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
  const namespace = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  const node = (dict as Record<string, unknown>)[namespace];
  if (node == null || typeof node !== 'object') return undefined;

  const flat = (node as Record<string, unknown>)[rest];
  if (typeof flat === 'string') return flat;

  let cursor: Json = node as Json;
  for (const segment of rest.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment] as Json;
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

export function substitute(template: string, params?: Record<string, string | number>): string {
  let out = template;
  if (params)
    for (const [name, value] of Object.entries(params)) out = out.replaceAll(`{${name}}`, String(value));
  return out;
}
