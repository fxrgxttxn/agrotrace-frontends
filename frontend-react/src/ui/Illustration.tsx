import type { CSSProperties, ReactNode } from 'react';

// Illustrations are inlined (README «Иконки и иллюстрации»: through <img> the colour tokens and the dark theme would
// be lost). The files are imported raw at build time and their inner markup — flat paths with
// `style="fill: var(--c-…)"`, no ids — is placed inside our own <svg class="at-empty__art" aria-hidden="true">.
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

/** `at-empty` (README «Пустое состояние»): illustration, one line, one action. */
export function Empty({ art, text, action }: { art: IllustrationName; text: ReactNode; action?: ReactNode }) {
  return (
    <div className="at-empty">
      <Illustration name={art} />
      <p className="at-empty__text">{text}</p>
      {action}
    </div>
  );
}

/** Inner markup of an illustration file (paths with `style="fill: var(--c-…)"`). */
export function illustrationMarkup(name: IllustrationName): string {
  const art = PARSED.get(name);
  if (!art) throw new Error(`Unknown illustration: ${name}`);
  return art.inner;
}
