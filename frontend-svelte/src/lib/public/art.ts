import recallWarning from '@agrotrace/design-system/illustrations/recall-warning.svg?raw';
import emptySearch from '@agrotrace/design-system/illustrations/empty-search.svg?raw';

// The illustrations the public page shows, and only those (README «Публичная QR-страница»): the inner markup of the
// design system's file inside our own <svg class="at-empty__art" aria-hidden="true">.

export interface ParsedArt {
  viewBox: string;
  inner: string;
}

function parseArt(raw: string): ParsedArt {
  const m = /^\s*<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(raw);
  return m ? { viewBox: m[1]!, inner: m[2]!.trim() } : { viewBox: '0 0 240 160', inner: '' };
}

export const ART = { recallWarning: parseArt(recallWarning), emptySearch: parseArt(emptySearch) };
