/**
 * ZIP archives read in memory with hard limits (P23) — the XLSX import never writes a temp file and never inflates more
 * than it allows. The central directory is the source of truth: at most `maxEntries` entries, a declared uncompressed
 * size of at most `maxEntryBytes` per entry and `maxTotalBytes` in all; each entry is inflated with
 * `maxOutputLength` = its declared size, so the bytes actually produced are bounded too (an entry that inflates to
 * more than it declares, or to less, is refused). Only the methods `stored` (0) and `deflate` (8) are read; encrypted
 * entries, ZIP64 and multi-disk archives are refused.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** The archive breaks a limit (`tooLarge`) or is not a readable ZIP (`invalid`). */
export class ZipError extends Error {
  constructor(readonly kind: 'tooLarge' | 'invalid') {
    super(`zip: ${kind}`);
  }
}

interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The central directory entries (names and declared sizes), limits checked; nothing is inflated. */
export function zipDirectory(b: Buffer, limits: ZipLimits): CentralEntry[] {
  const from = Math.max(0, b.length - 22 - 65_535);
  let eocd = -1;
  for (let i = b.length - 22; i >= from; i--)
    if (b.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new ZipError('invalid');
  if (b.readUInt16LE(eocd + 4) !== 0 || b.readUInt16LE(eocd + 6) !== 0) throw new ZipError('invalid');
  const count = b.readUInt16LE(eocd + 10);
  if (count === 0xffff) throw new ZipError('invalid'); // ZIP64
  if (count > limits.maxEntries) throw new ZipError('tooLarge');
  let p = b.readUInt32LE(eocd + 16);
  const out: CentralEntry[] = [];
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== CENTRAL) throw new ZipError('invalid');
    const nameLen = b.readUInt16LE(p + 28);
    const extra = b.readUInt16LE(p + 30);
    const comment = b.readUInt16LE(p + 32);
    if (p + 46 + nameLen > b.length) throw new ZipError('invalid');
    const e: CentralEntry = {
      flags: b.readUInt16LE(p + 8),
      method: b.readUInt16LE(p + 10),
      crc: b.readUInt32LE(p + 16),
      compressedSize: b.readUInt32LE(p + 20),
      size: b.readUInt32LE(p + 24),
      localOffset: b.readUInt32LE(p + 42),
      name: b.toString('utf8', p + 46, p + 46 + nameLen),
    };
    if (e.size === 0xffffffff || e.compressedSize === 0xffffffff) throw new ZipError('invalid'); // ZIP64
    if (e.size > limits.maxEntryBytes) throw new ZipError('tooLarge');
    total += e.size;
    if (total > limits.maxTotalBytes) throw new ZipError('tooLarge');
    out.push(e);
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/** Inflates the entries `wanted` (by name) — each bounded by its declared size — in directory order. */
export function unzip(b: Buffer, limits: ZipLimits, wanted: (name: string) => boolean): ZipEntry[] {
  const out: ZipEntry[] = [];
  for (const e of zipDirectory(b, limits)) {
    if (!wanted(e.name)) continue;
    if (e.flags & 0x1) throw new ZipError('invalid'); // encrypted
    const p = e.localOffset;
    if (p + 30 > b.length || b.readUInt32LE(p) !== LOCAL) throw new ZipError('invalid');
    const start = p + 30 + b.readUInt16LE(p + 26) + b.readUInt16LE(p + 28);
    const end = start + e.compressedSize;
    if (end > b.length) throw new ZipError('invalid');
    const raw = b.subarray(start, end);
    let data: Buffer;
    if (e.method === 0) data = Buffer.from(raw);
    else if (e.method === 8) {
      try {
        // One byte more than declared tells "inflates to more than it says" apart from "exactly as declared".
        data = inflateRawSync(raw, { maxOutputLength: e.size + 1 });
      } catch (err) {
        throw new ZipError(
          (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'tooLarge' : 'invalid',
        );
      }
    } else throw new ZipError('invalid');
    if (data.length > e.size) throw new ZipError('tooLarge');
    if (data.length !== e.size || crc32(data) !== e.crc) throw new ZipError('invalid');
    out.push({ name: e.name, data });
  }
  return out;
}

/** A ZIP of stored (uncompressed) entries in the given order. */
export function storedZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of entries) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, f.data);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
