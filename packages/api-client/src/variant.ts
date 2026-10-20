import type { components } from './schema';

/** R28/R39 helper: sets (or replaces) the `variant` query param of a signed or public file URL
 * without touching any other param (`exp`/`sig` are never re-derived client-side). The type is the
 * contract's own `ImageVariant` parameter (`96 | 480`, contracts/openapi/components/parameters.yaml). */
export function withVariant(url: string, variant: components['parameters']['ImageVariant']): string {
  const separatorIndex = url.indexOf('?');
  const path = separatorIndex === -1 ? url : url.slice(0, separatorIndex);
  const query = separatorIndex === -1 ? '' : url.slice(separatorIndex + 1);
  const params = new URLSearchParams(query);
  params.set('variant', String(variant));
  return `${path}?${params.toString()}`;
}
