import type { components } from './schema';

export function withVariant(url: string, variant: components['parameters']['ImageVariant']): string {
  const separatorIndex = url.indexOf('?');
  const path = separatorIndex === -1 ? url : url.slice(0, separatorIndex);
  const query = separatorIndex === -1 ? '' : url.slice(separatorIndex + 1);
  const params = new URLSearchParams(query);
  params.set('variant', String(variant));
  return `${path}?${params.toString()}`;
}
