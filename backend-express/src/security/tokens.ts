/** Opaque one-time tokens (R82): 32 random bytes, base64url without padding (43 characters); stored only as sha256. */
import { createHash, randomBytes } from 'node:crypto';

export const newOpaqueToken = (): string => randomBytes(32).toString('base64url');

export const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
