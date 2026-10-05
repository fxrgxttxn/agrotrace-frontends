import type { CSSProperties, ReactNode } from 'react';
import { ArtSvg, parseArt, type ParsedArt } from './Art';

const FILES = import.meta.glob('../../../packages/design-system/illustrations/*.svg', {
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

const PARSED = new Map<string, ParsedArt>();
for (const [path, raw] of Object.entries(FILES)) {
  const name = /([a-z-]+)\.svg$/.exec(path)?.[1];
  const art = parseArt(raw);
  if (name && art) PARSED.set(name, art);
}

export function Illustration({
  name,
  className = 'at-empty__art',
  style,
}: {
  name: IllustrationName;
  className?: string;
  style?: CSSProperties;
}) {
  const art = PARSED.get(name);
  if (!art) throw new Error(`Unknown illustration: ${name}`);
  return <ArtSvg art={art} className={className} style={style} />;
}

export function Empty({ art, text, action }: { art: IllustrationName; text: ReactNode; action?: ReactNode }) {
  return (
    <div className="at-empty">
      <Illustration name={art} />
      <p className="at-empty__text">{text}</p>
      {action}
    </div>
  );
}

export function illustrationMarkup(name: IllustrationName): string {
  const art = PARSED.get(name);
  if (!art) throw new Error(`Unknown illustration: ${name}`);
  return art.inner;
}
