function parseDecimal(s: string): { digits: bigint; scale: number } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`invalid decimal: ${s}`);
  const frac = m[2] ?? '';
  return { digits: BigInt(m[1]! + frac), scale: frac.length };
}

export function compareDecimalStrings(a: string, b: string): number {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const scale = Math.max(pa.scale, pb.scale);
  const da = pa.digits * 10n ** BigInt(scale - pa.scale);
  const db = pb.digits * 10n ** BigInt(scale - pb.scale);
  if (da < db) return -1;
  if (da > db) return 1;
  return 0;
}

export function kgToGrams(s: string): bigint {
  const m = /^\d{1,9}(?:\.\d{1,3})?$/.exec(s);
  if (!m) throw new RangeError(`invalid mass: ${s}`);
  const [intPart, fracPart = ''] = s.split('.');
  return BigInt(intPart!) * 1000n + BigInt(fracPart.padEnd(3, '0'));
}

export function gramsToKg(g: bigint): string {
  const neg = g < 0n;
  const a = neg ? -g : g;
  return `${neg ? '-' : ''}${a / 1000n}.${(a % 1000n).toString().padStart(3, '0')}`;
}

export function percentToBasisPoints(s: string): bigint {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid percent: ${s}`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

export function ratioPercent2(n: bigint, d: bigint): string {
  const scaled = (n * 10000n * 2n + d) / (2n * d);
  return `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, '0')}`;
}
