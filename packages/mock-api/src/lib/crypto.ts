import { hmac } from '@noble/hashes/hmac';
import { sha1 } from '@noble/hashes/sha1';
import { sha256 } from '@noble/hashes/sha256';

const enc = new TextEncoder();
export const utf8 = (s: string): Uint8Array => enc.encode(s);

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export const sha256hex = (data: Uint8Array | string): string =>
  hex(sha256(typeof data === 'string' ? utf8(data) : data));

export const hmacSha256 = (key: Uint8Array | string, msg: Uint8Array | string): Uint8Array =>
  hmac(sha256, typeof key === 'string' ? utf8(key) : key, typeof msg === 'string' ? utf8(msg) : msg);

export function base64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export const opaqueToken = (): string => base64url(randomBytes(32));

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function uuidV5(namespace: string, name: string): string {
  const ns = Uint8Array.from(namespace.replace(/-/g, '').match(/../g)!.map((x) => parseInt(x, 16)));
  const h = sha1.create().update(ns).update(utf8(name)).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = hex(h.subarray(0, 16));
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const MOCK_NAMESPACE = '0b7c1e52-9a3f-5d61-8e2a-4c6f8d0b1a3e';

export const randomUuid = (): string => uuidV5(MOCK_NAMESPACE, `random:${hex(randomBytes(16))}`);
