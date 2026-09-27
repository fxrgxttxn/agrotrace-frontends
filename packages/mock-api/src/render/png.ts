/**
 * QR code PNG (createBatchQr, R43): the public URL at error correction level M with a 4-module quiet zone, black on
 * white, 1024 × 1024 px (the seed's `qrPng` parameters). Encoded by uqr, written as a 1-bit grayscale PNG.
 */
import { zlibSync } from 'fflate';
import { encode } from 'uqr';

export const QR_SIZE_PX = 1024;

/** QR modules including the quiet zone (`true` — dark). */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: 'M', border: 4 }).data;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** A 1-bit grayscale PNG of `pixel(x, y)` (true — black). */
export function pngBitmap(width: number, height: number, pixel: (x: number, y: number) => boolean): Uint8Array {
  const stride = Math.ceil(width / 8);
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      // Grayscale bit 1 = white.
      if (!pixel(x, y)) raw[row + 1 + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // grayscale
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The QR PNG of `url`, 1024 × 1024 px. */
export function qrPng(url: string): Uint8Array {
  const m = qrMatrix(url);
  const n = m.length;
  return pngBitmap(QR_SIZE_PX, QR_SIZE_PX, (x, y) => m[Math.floor((y * n) / QR_SIZE_PX)]![Math.floor((x * n) / QR_SIZE_PX)]!);
}
