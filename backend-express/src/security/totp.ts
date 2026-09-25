/**
 * TOTP (R35): RFC 6238, SHA1, 6 digits, 30 s step, ±1 step accepted. `matchStep` returns the time step the code
 * belongs to, so the caller can refuse a step already accepted for the user (`totp-used:{userId}:{step}`, R82).
 */
import { authenticator } from 'otplib';

export const TOTP_STEP_SEC = 30;
const ISSUER = 'AgroTrace';

const totp = authenticator.clone({ step: TOTP_STEP_SEC, digits: 6, window: 1 });

/** A new Base32 secret (20 random bytes → 32 characters, contract pattern ^[A-Z2-7]{16,64}$). */
export const generateTotpSecret = (): string => totp.generateSecret(20);

export const otpauthUrl = (email: string, secret: string): string => totp.keyuri(email, ISSUER, secret);

/** The accepted step (±1 around `now`) of `code`, or null. */
export function matchStep(secret: string, code: string, now = Date.now()): number | null {
  const at = totp.clone({ epoch: now });
  const delta = at.checkDelta(code, secret);
  if (delta === null) return null;
  return Math.floor(now / 1000 / TOTP_STEP_SEC) + delta;
}
