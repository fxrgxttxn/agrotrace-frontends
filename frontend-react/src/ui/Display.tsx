import type { ReactNode } from 'react';
import { t } from '../app/i18n';
import { ChipView, type Tone } from './DisplayBase';

export {
  ChipView,
  initials,
  Avatar,
  Timeline,
  Card,
  CardHeader,
  CardBody,
  CardFacts,
  CardFooter,
  type Tone,
  type TimelineEntry,
} from './DisplayBase';

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
    <ChipView status={status} tone={tone} size={size}>
      {children ?? (status ? t(`status.batch.${status}`) : null)}
    </ChipView>
  );
}

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

export function Spinner() {
  return <span className="at-spinner" aria-hidden="true"></span>;
}

export function Skeleton({ shape = 'text', width }: { shape?: 'text' | 'block' | 'circle'; width?: string }) {
  return <span className="at-skeleton" data-shape={shape} style={width ? { width } : undefined}></span>;
}

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
