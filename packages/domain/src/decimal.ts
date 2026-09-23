/**
 * Exact decimal arithmetic on decimal strings, via scale-normalized BigInt.
 * Never uses Number/parseFloat for comparison or arithmetic on money/mass/
 * percent values - see BR-02's ruling: 9.5 vs 10.0, 10 vs 9.99 and 2.0 vs
 * 2.00 must compare correctly, which float parsing can get subtly wrong for
 * some decimal strings and which naive string comparison always gets wrong.
 */

/** Parses a non-negative decimal string into its unscaled digits + scale. */
function parseDecimal(s: string): { digits: bigint; scale: number } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`invalid decimal: ${s}`);
  const frac = m[2] ?? '';
  return { digits: BigInt(m[1]! + frac), scale: frac.length };
}

/** -1 if a < b, 0 if a == b, 1 if a > b - exact, scale-normalized. */
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
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid mass: ${s}`);
  return BigInt(m[1]!) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0'));
}

export function gramsToKg(g: bigint): string {
  const neg = g < 0n;
  const a = neg ? -g : g;
  return `${neg ? '-' : ''}${a / 1000n}.${(a % 1000n).toString().padStart(3, '0')}`;
}

/** lossNormPercent matches ^\d{1,3}(\.\d{1,2})?$ (R23); returns percent*100. */
export function percentToBasisPoints(s: string): bigint {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid percent: ${s}`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

/** round half up of n/d*100 to 2 decimals, returns "N.NN" (n, d >= 0). */
export function ratioPercent2(n: bigint, d: bigint): string {
  const scaled = (n * 10000n * 2n + d) / (2n * d); // percent*100, half-up
  return `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, '0')}`;
}
