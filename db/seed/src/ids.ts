import { sha1 } from '@noble/hashes/sha1';
import { sha256 } from '@noble/hashes/sha256';

export const SEED_NAMESPACE = '6f1c2b8e-3d4a-5e6f-8a9b-0c1d2e3f4a5b';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const NAMESPACE_BYTES = Uint8Array.from(
  SEED_NAMESPACE.replace(/-/g, '')
    .match(/../g)!
    .map((b) => parseInt(b, 16)),
);

export function uuid(kind: string, key: string): string {
  const h = sha1.create().update(NAMESPACE_BYTES).update(utf8(`${kind}:${key}`)).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = Array.from(h.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function hashInt(label: string, n: number): number {
  const d = sha256(utf8(label));
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0, false) % n;
}
