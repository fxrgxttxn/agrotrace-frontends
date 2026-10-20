/**
 * Passwords (spec 8.8, R31): Argon2id PHC strings, m=65536 KiB, t=3, p=1 — the same parameters as the seed
 * (db/seed/src/passwords.ts), so any backend verifies any hash. Passwords are compared byte-exact: never trimmed or
 * normalized (R36).
 */
import argon2 from 'argon2';

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export const hashPassword = (password: string): Promise<string> => argon2.hash(password, ARGON2_OPTIONS);

/** false for a wrong password and for a stored value that is not a valid PHC hash (e.g. an invited user's '!'). */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;

/**
 * R31 step 2: an unknown email still costs one Argon2 verification (against a hash of a random password with the same
 * parameters), so the response time does not reveal whether the account exists.
 */
export async function dummyVerify(password: string): Promise<void> {
  dummy ??= hashPassword(`dummy-${Math.random()}-${Date.now()}`);
  await verifyPassword(await dummy, password);
}
