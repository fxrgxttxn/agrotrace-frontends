import type { CSSProperties, ReactNode } from 'react';

export type Tone = 'neutral' | 'attention' | 'ok' | 'move' | 'danger' | 'danger-solid';

export function ChipView({
  status,
  tone,
  size,
  children,
}: {
  status?: string;
  tone?: Tone;
  size?: 'l';
  children: ReactNode;
}) {
  return (
    <span className="at-chip" data-status={status} data-tone={tone} data-size={size}>
      {children}
    </span>
  );
}

export function initials(fullName: string): string {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return [...parts[0]!].slice(0, 2).join('').toLocaleUpperCase('ru');
  return ([...parts[0]!][0]! + [...parts[1]!][0]!).toLocaleUpperCase('ru');
}

export function Avatar({
  name,
  src,
  size = 'm',
  shape,
  decorative,
  hidden,
}: {
  name: string;
  src?: string | null;
  size?: 's' | 'm' | 'l';
  shape?: 'square';
  decorative?: boolean;
  hidden?: boolean;
}) {
  if (src)
    return (
      <span
        className="at-avatar"
        data-size={size}
        data-shape={shape}
        aria-hidden={hidden ? 'true' : undefined}
      >
        <img src={src} alt={decorative || hidden ? '' : name} />
      </span>
    );
  const silent = decorative || hidden;
  return (
    <span
      className="at-avatar"
      data-size={size}
      data-shape={shape}
      role={silent ? undefined : 'img'}
      aria-label={silent ? undefined : name}
      aria-hidden={silent ? 'true' : undefined}
    >
      {initials(name)}
    </span>
  );
}

export interface TimelineEntry {
  key: string;
  at: string;
  atText: string;
  title: ReactNode;
  meta?: ReactNode;
  tone?: Tone;
}

export function Timeline({ items }: { items: TimelineEntry[] }) {
  return (
    <ol className="at-timeline">
      {items.map((it, i) => (
        <li
          key={it.key}
          className="at-timeline__item"
          data-tone={it.tone}
          data-current={i === items.length - 1 ? '' : undefined}
        >
          <time className="at-timeline__time" dateTime={it.at}>
            {it.atText}
          </time>
          <p className="at-timeline__title">{it.title}</p>
          {it.meta !== undefined && <p className="at-timeline__meta">{it.meta}</p>}
        </li>
      ))}
    </ol>
  );
}

export function Card({
  furrow,
  children,
  style,
}: {
  furrow?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <article className="at-card" data-furrow={furrow ? '' : undefined} style={style}>
      {children}
    </article>
  );
}

export function CardHeader({
  title,
  level = 2,
  titleId,
  children,
}: {
  title: ReactNode;
  level?: 1 | 2 | 3;
  titleId?: string;
  children?: ReactNode;
}) {
  const H = `h${level}` as 'h1' | 'h2' | 'h3';
  return (
    <header className="at-card__header">
      <H className="at-card__title" id={titleId}>
        {title}
      </H>
      {children}
    </header>
  );
}

export function CardBody({ children }: { children: ReactNode }) {
  return <div className="at-card__body">{children}</div>;
}

export function CardFacts({ facts }: { facts: { term: ReactNode; value: ReactNode; key?: string }[] }) {
  return (
    <dl className="at-card__facts">
      {facts.map((f, i) => (
        <div key={f.key ?? i}>
          <dt>{f.term}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CardFooter({ children }: { children: ReactNode }) {
  return <footer className="at-card__footer">{children}</footer>;
}
