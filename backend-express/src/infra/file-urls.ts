/**
 * File URLs (contract `SignedFileUrl`/`PublicFileUrl`, R28/R34/R39/R88): logos and product images are public
 * (`/api/v1/public/files/{id}`); avatars, lab protocols, QR and reports are signed —
 * `fileUrlKey = HMAC-SHA256(JWT_SECRET, "agrotrace:file-url:v1")`, `sig = hex(HMAC-SHA256(fileUrlKey, "{id}:{exp}"))`,
 * `exp` = now + 3600 (Unix seconds). The same recipe in every backend, so a URL signed by one is served by any.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNED_URL_TTL_SEC = 3600;

export const fileUrlKey = (jwtSecret: string): Buffer =>
  createHmac('sha256', jwtSecret).update('agrotrace:file-url:v1').digest();

export const fileSignature = (key: Buffer, id: string, exp: number): string =>
  createHmac('sha256', key).update(`${id.toLowerCase()}:${exp}`).digest('hex');

export interface FileUrls {
  signed(id: string, now?: Date): string;
  /** Checks a signature from a query (`exp` not in the past). */
  verify(id: string, exp: number, sig: string, now?: Date): boolean;
}

export function createFileUrls(jwtSecret: string): FileUrls {
  const key = fileUrlKey(jwtSecret);
  return {
    signed(id, now = new Date()) {
      const exp = Math.floor(now.getTime() / 1000) + SIGNED_URL_TTL_SEC;
      return `/api/v1/files/${id.toLowerCase()}?exp=${exp}&sig=${fileSignature(key, id, exp)}`;
    },
    verify(id, exp, sig, now = new Date()) {
      if (!Number.isSafeInteger(exp) || exp < Math.floor(now.getTime() / 1000)) return false;
      if (!/^[0-9a-f]{64}$/.test(sig)) return false;
      return timingSafeEqual(Buffer.from(fileSignature(key, id, exp), 'hex'), Buffer.from(sig, 'hex'));
    },
  };
}

export const publicFileUrl = (id: string): string => `/api/v1/public/files/${id.toLowerCase()}`;
