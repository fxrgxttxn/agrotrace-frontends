export type Tone = 'neutral' | 'attention' | 'ok' | 'move' | 'danger' | 'danger-solid';

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
