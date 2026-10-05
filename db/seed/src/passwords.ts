import { createHash } from 'node:crypto';
import argon2 from 'argon2';

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

export function hashDemoPassword(email: string, password: string): Promise<string> {
  const salt = createHash('sha256').update(`agrotrace-seed:${email}`).digest().subarray(0, 16);
  return argon2.hash(password, { ...ARGON2_OPTIONS, salt });
}
