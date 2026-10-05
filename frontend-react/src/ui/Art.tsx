import type { CSSProperties } from 'react';

export interface ParsedArt {
  viewBox: string;
  inner: string;
}

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
