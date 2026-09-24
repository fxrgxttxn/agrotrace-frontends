import { createHash } from 'node:crypto';
import argon2 from 'argon2';

/** Argon2id parameters of every AgroTrace password hash (R31/R35): PHC string m=65536,t=3,p=1. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

/**
 * Argon2id PHC hash of a demo password. The salt is derived from the email so that re-seeding
 * produces byte-identical rows (seed determinism); real users get random salts from the backends.
 */
export function hashDemoPassword(email: string, password: string): Promise<string> {
  const salt = createHash('sha256').update(`agrotrace-seed:${email}`).digest().subarray(0, 16);
  return argon2.hash(password, { ...ARGON2_OPTIONS, salt });
}
