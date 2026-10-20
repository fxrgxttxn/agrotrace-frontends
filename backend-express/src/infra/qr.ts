/**
 * QR code PNG of a batch (createBatchQr, R43): the public page URL `{PUBLIC_BASE_URL}/p/{publicCode}` at error
 * correction level M, 1024 × 1024 px, black on white, a 4-module quiet zone — the seed's `qrPng` parameters
 * (db/seed/src/files.ts), so a regenerated QR looks exactly like a seeded one.
 */
import QRCode from 'qrcode';

export const QR_SIZE_PX = 1024;

/** `{PUBLIC_BASE_URL}/p/{publicCode}` (QrLinks.publicUrl; the base may carry a path, never a trailing `/`, R50). */
export const publicPageUrl = (publicBaseUrl: string, publicCode: string): string =>
  `${publicBaseUrl.replace(/\/+$/, '')}/p/${publicCode}`;

export function qrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: QR_SIZE_PX,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}
