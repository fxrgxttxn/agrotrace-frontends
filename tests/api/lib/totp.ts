/**
 * TOTP codes as an authenticator app computes them (R35: RFC 6238, SHA1, 6 digits, 30 s step) — written out here so
 * the suite depends on the RFC, not on a backend's library.
 */
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`not base32: ${ch}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const STEP_SEC = 30;
export const currentStep = (nowMs = Date.now()): number => Math.floor(nowMs / 1000 / STEP_SEC);

/** The code of time step `step` (HOTP of the step counter, RFC 4226 dynamic truncation). */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(bin).padStart(6, '0');
}

/**
 * Waits until at least `marginSec` remain in the current step, so a code computed now for step s±k is still s±k
 * relative to the server's step when the request lands (same host clock).
 */
export async function awayFromStepEdge(marginSec = 3): Promise<void> {
  const inStep = (Date.now() / 1000) % STEP_SEC;
  if (STEP_SEC - inStep < marginSec)
    await new Promise((r) => setTimeout(r, (STEP_SEC - inStep + 0.3) * 1000));
}
