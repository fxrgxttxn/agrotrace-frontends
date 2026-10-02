// Key lookup and `{name}` substitution, shared by `makeT` (translate.ts, adds plurals) and `publicT` (public.ts: the
// public page texts have no plural templates — a test keeps it so — and its bundle skips the plural code).

type Json = Record<string, unknown> | string;

/**
 * Resolves a dotted key such as `validation.email.taken` or
 * `status.batch.Created`. Namespaces that store flat i18n keys (currently
 * `validation`, whose keys mirror the contract's dotted `validation.*` error
 * codes literally, including the dots) are tried first; namespaces that
 * nest by level (`status.<enum>.<Value>`, `rules.BR-01`, `errors.<CODE>`)
 * fall back to walking the remaining segments one at a time.
 */
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

/** Replaces every `{name}` of `params` in `template`. */
export function substitute(template: string, params?: Record<string, string | number>): string {
  let out = template;
  if (params)
    for (const [name, value] of Object.entries(params)) out = out.replaceAll(`{${name}}`, String(value));
  return out;
}
