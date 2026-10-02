import type { CSSProperties } from 'react';

// An inlined illustration (README «Иконки и иллюстрации»): the inner markup of a file of
// packages/design-system/illustrations — flat paths with `style="fill: var(--c-…)"`, no ids — inside our own
// <svg class="at-empty__art" aria-hidden="true">. No file list here: the cabinet (Illustration.tsx) imports them all,
// the public QR page only the ones it shows.

export interface ParsedArt {
  viewBox: string;
  inner: string;
}

/** Parses the raw text of an illustration file. */
export function parseArt(raw: string): ParsedArt | null {
  const m = /^\s*<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(raw);
  return m ? { viewBox: m[1]!, inner: m[2]!.trim() } : null;
}

export function ArtSvg({
  art,
  className = 'at-empty__art',
  style,
}: {
  art: ParsedArt;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      viewBox={art.viewBox}
      style={style}
      dangerouslySetInnerHTML={{ __html: art.inner }}
    />
  );
}
