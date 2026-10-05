import { hmac } from '@noble/hashes/hmac';
import { sha1 } from '@noble/hashes/sha1';
import { base64url, fromBase64url, hmacSha256, randomBytes, timingSafeEqualHex, hex, utf8 } from '../lib/crypto.js';
import type { Principal, RoleCode } from '../store/types.js';

export const ACCESS_TTL_SEC = 900;
const ROLE_CODES: RoleCode[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];

const json64 = (v: unknown): string => base64url(utf8(JSON.stringify(v)));

export function issueAccessToken(secret: string, p: Principal, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const head = json64({ alg: 'HS256', typ: 'JWT' });
  const body = json64({
    sub: p.userId,
    org: p.orgId,
    roles: p.roles,
    org_admin: p.orgAdmin,
    iat,
    exp: iat + ACCESS_TTL_SEC,
    jti: hex(randomBytes(16)),
  });
  return `${head}.${body}.${base64url(hmacSha256(secret, `${head}.${body}`))}`;
}

export function verifyAccessToken(secret: string, token: string, nowMs: number): (Principal & { exp: number }) | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  try {
    const h = JSON.parse(new TextDecoder().decode(fromBase64url(head))) as Record<string, unknown>;
    if (h.alg !== 'HS256' || 'crit' in h) return null;
    const expected = hex(hmacSha256(secret, `${head}.${body}`));
    if (!timingSafeEqualHex(expected, hex(fromBase64url(sig)))) return null;
    const c = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as Record<string, unknown>;
    if (
      typeof c.sub !== 'string' ||
      typeof c.org !== 'string' ||
      !Array.isArray(c.roles) ||
      c.roles.length === 0 ||
      !c.roles.every((r) => ROLE_CODES.includes(r as RoleCode)) ||
      typeof c.org_admin !== 'boolean' ||
      !Number.isInteger(c.exp) ||
      !Number.isInteger(c.iat) ||
      typeof c.jti !== 'string'
    )
      return null;
    if ((c.exp as number) * 1000 <= nowMs) return null;
    return {
      userId: c.sub,
      orgId: c.org,
      roles: c.roles as RoleCode[],
      orgAdmin: c.org_admin,
      exp: c.exp as number,
    };
  } catch {
    return null;
  }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(b: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const x of b) {
    value = (value << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export function totpAt(secret: string, step: number): string {
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setUint32(4, step >>> 0);
  new DataView(counter.buffer).setUint32(0, Math.floor(step / 2 ** 32));
  const mac = hmac(sha1, base32Decode(secret), counter);
  const o = mac[mac.length - 1]! & 0xf;
  const code = ((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

export const totpNow = (secret: string, nowMs: number): string => totpAt(secret, Math.floor(nowMs / 30_000));

export function matchTotpStep(secret: string, code: string, nowMs: number): number | null {
  const step = Math.floor(nowMs / 30_000);
  for (const s of [step, step - 1, step + 1]) if (totpAt(secret, s) === code) return s;
  return null;
}

export const otpauthUrl = (email: string, secret: string): string =>
  `otpauth://totp/AgroTrace:${encodeURIComponent(email)}?secret=${secret}&issuer=AgroTrace`;
