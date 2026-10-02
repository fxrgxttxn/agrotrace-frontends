import type { CSSProperties, ReactNode } from 'react';
import { t } from '../app/i18n';

/** `at-spinner`: the ploughed furrow (decorative; the busy area carries `aria-busy`). */
export function Spinner() {
  return <span className="at-spinner" aria-hidden="true"></span>;
}

export type Tone = 'neutral' | 'attention' | 'ok' | 'move' | 'danger' | 'danger-solid';

/** `at-chip` (README «Статус»): `status` — a contract `BatchStatus` (text from `status.batch.*`), or `tone` for the
 * other entities with the caller's text. */
export function Chip({
  status,
  tone,
  size,
  children,
}: {
  status?: string;
  tone?: Tone;
  size?: 'l';
  children?: ReactNode;
}) {
  return (
    <span className="at-chip" data-status={status} data-tone={tone} data-size={size}>
      {children ?? (status ? t(`status.batch.${status}`) : null)}
    </span>
  );
}

/** `at-skeleton`; the loading area itself carries `aria-busy="true"`. */
export function Skeleton({ shape = 'text', width }: { shape?: 'text' | 'block' | 'circle'; width?: string }) {
  return <span className="at-skeleton" data-shape={shape} style={width ? { width } : undefined}></span>;
}

/** Initials for a text avatar: first letters of the first two words, in the order the name is written
 * («Иван Петров» → «ИП», README; «Петров Иван Сергеевич» → «ПИ»). One word → its first two letters. Quotes and other
 * signs before a word are skipped («ООО «Кубанский мукомол»» → «ОК», not «О«»). */
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

/** `at-avatar` (README «Аватар»). With `src`: an image (`alt` = name, or `''` when `decorative`); without: initials,
 * `role="img"` + `aria-label`, or `aria-hidden` when `decorative`. `hidden` hides the whole avatar from assistive
 * technology (inside a link that already names the person). */
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

/** Sparkline path for `at-metric` (viewBox 96 × 32, 2 px inset). */
export function sparkPoints(values: number[]): string {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = 2 + (i * 92) / (values.length - 1);
      const y = 30 - ((v - min) * 28) / span;
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(' ');
}

/** `at-metric` (README «Показатель»). */
export function Metric({
  label,
  value,
  unit,
  tone,
  spark,
  delta,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  tone?: 'danger';
  spark?: number[];
  /** A second line under the value (`at-metric__delta`): «из них просрочено: 1». */
  delta?: ReactNode;
}) {
  return (
    <div className="at-metric" data-tone={tone}>
      <p className="at-metric__label">{label}</p>
      <p className="at-metric__value">
        {value}
        {unit !== undefined && <span className="at-metric__unit">{unit}</span>}
        {delta !== undefined && <span className="at-metric__delta">{delta}</span>}
      </p>
      {spark && spark.length > 1 && (
        <div className="at-metric__spark" aria-hidden="true">
          <svg viewBox="0 0 96 32">
            <polyline
              points={sparkPoints(spark)}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}
    </div>
  );
}

/** `at-progress` (README «Прогресс»): «N из M» with a labelled `<progress>`. */
export function Progress({
  id,
  label,
  value,
  max,
  tone,
  labelHidden,
}: {
  id: string;
  label: ReactNode;
  value: number;
  max: number;
  tone?: 'danger';
  /** In a table cell the column header says it: the label stays for the bar's name, visually hidden (README). */
  labelHidden?: boolean;
}) {
  return (
    <div className="at-progress" data-tone={tone}>
      <span className={labelHidden ? 'at-progress__label at-visually-hidden' : 'at-progress__label'} id={id}>
        {label}
      </span>
      <span className="at-progress__value">{t('ui.progressValue', { value, max })}</span>
      <progress className="at-progress__bar" max={max} value={value} aria-labelledby={id}></progress>
    </div>
  );
}

/** `at-stepper` (README «Шаги»): steps before `current` are done, `current` is `aria-current="step"`. */
export function Stepper({ label, steps, current }: { label: string; steps: string[]; current: number }) {
  return (
    <ol className="at-stepper" aria-label={label}>
      {steps.map((s, i) => (
        <li
          key={s}
          className="at-stepper__step"
          data-done={i < current ? '' : undefined}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="at-stepper__marker">{i + 1}</span>
          <span className="at-stepper__label">{s}</span>
        </li>
      ))}
    </ol>
  );
}

export interface TimelineEntry {
  key: string;
  /** ISO instant for `datetime`. */
  at: string;
  /** Display text of the instant (ДД.ММ.ГГГГ, ЧЧ:ММ). */
  atText: string;
  title: ReactNode;
  meta?: ReactNode;
  tone?: Tone;
}

/** `at-timeline` (README «История»): the last entry is `data-current`. */
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

/** `at-card` pieces (README «Карточка»). `furrow` — only the public QR page and the login screen. */
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
