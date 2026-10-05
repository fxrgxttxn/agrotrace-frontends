import { useMemo } from 'react';
import { encode } from 'uqr';

export function qrPath(text: string): { size: number; d: string } {
  const { data, size } = encode(text, { ecc: 'M', border: 2 });
  let d = '';
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < size && row[x + run]) run += 1;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  });
  return { size, d };
}

export function Qr({ value, label, size = 192 }: { value: string; label: string; size?: number }) {
  const { size: modules, d } = useMemo(() => qrPath(value), [value]);
  return (
    <span data-theme="light" style={{ display: 'inline-block', lineHeight: 0 }}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${modules} ${modules}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
        style={{ background: 'var(--c-surface)', borderRadius: 'var(--r-s)' }}
      >
        <path d={d} style={{ fill: 'var(--c-ink)' }} />
      </svg>
    </span>
  );
}
