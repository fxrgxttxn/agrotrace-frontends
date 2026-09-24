import { createHash } from 'node:crypto';

/** Fixed namespace of all seed UUIDs (RFC 4122 v5 = SHA-1 of namespace + name). */
export const SEED_NAMESPACE = '6f1c2b8e-3d4a-5e6f-8a9b-0c1d2e3f4a5b';

/** Deterministic UUID v5 for a seed entity, e.g. `uuid('batch', 'milk1')`. */
export function uuid(kind: string, key: string): string {
  const ns = Buffer.from(SEED_NAMESPACE.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(`${kind}:${key}`, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Deterministic pseudo-random integer in [0, n) derived from a label. */
export function hashInt(label: string, n: number): number {
  return createHash('sha256').update(label, 'utf8').digest().readUInt32BE(0) % n;
}
