import recallWarning from '@agrotrace/design-system/illustrations/recall-warning.svg?raw';
import emptySearch from '@agrotrace/design-system/illustrations/empty-search.svg?raw';

export interface ParsedArt {
  viewBox: string;
  inner: string;
}

function parseArt(raw: string): ParsedArt {
  const m = /^\s*<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(raw);
  return m ? { viewBox: m[1]!, inner: m[2]!.trim() } : { viewBox: '0 0 240 160', inner: '' };
}

export const ART = { recallWarning: parseArt(recallWarning), emptySearch: parseArt(emptySearch) };
