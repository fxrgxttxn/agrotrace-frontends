import { zlibSync } from 'fflate';

const enc = new TextEncoder();

export interface TtfFont {
  bytes: Uint8Array;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  bbox: [number, number, number, number];
  cmap: Map<number, number>;
  advances: number[];
}

export function parseTtf(bytes: Uint8Array): TtfFont {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = v.getUint16(4);
  const tables = new Map<string, number>();
  for (let i = 0; i < numTables; i++) {
    const e = 12 + i * 16;
    const tag = String.fromCharCode(bytes[e]!, bytes[e + 1]!, bytes[e + 2]!, bytes[e + 3]!);
    tables.set(tag, v.getUint32(e + 8));
  }
  const at = (tag: string): number => {
    const o = tables.get(tag);
    if (o === undefined) throw new Error(`font has no ${tag} table`);
    return o;
  };
  const head = at('head');
  const hhea = at('hhea');
  const hmtx = at('hmtx');
  const maxp = at('maxp');
  const unitsPerEm = v.getUint16(head + 18);
  const bbox: [number, number, number, number] = [
    v.getInt16(head + 36),
    v.getInt16(head + 38),
    v.getInt16(head + 40),
    v.getInt16(head + 42),
  ];
  const ascent = v.getInt16(hhea + 4);
  const descent = v.getInt16(hhea + 6);
  const nMetrics = v.getUint16(hhea + 34);
  const numGlyphs = v.getUint16(maxp + 4);
  const advances: number[] = [];
  let last = 0;
  for (let g = 0; g < numGlyphs; g++) {
    if (g < nMetrics) last = v.getUint16(hmtx + g * 4);
    advances.push(last);
  }
  const cmap = new Map<number, number>();
  const cm = at('cmap');
  const n = v.getUint16(cm + 2);
  for (let i = 0; i < n; i++) {
    const platform = v.getUint16(cm + 4 + i * 8);
    const encoding = v.getUint16(cm + 6 + i * 8);
    const sub = cm + v.getUint32(cm + 8 + i * 8);
    const format = v.getUint16(sub);
    if (format === 4 && (platform === 3 || platform === 0) && (encoding === 1 || platform === 0)) {
      const segX2 = v.getUint16(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = v.getUint16(ends + s * 2);
        const start = v.getUint16(starts + s * 2);
        const delta = v.getInt16(deltas + s * 2);
        const rangeOffset = v.getUint16(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let gid: number;
          if (rangeOffset === 0) gid = (c + delta) & 0xffff;
          else {
            const addr = ranges + s * 2 + rangeOffset + (c - start) * 2;
            gid = v.getUint16(addr);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid !== 0 && !cmap.has(c)) cmap.set(c, gid);
        }
      }
    } else if (format === 12) {
      const groups = v.getUint32(sub + 12);
      for (let g = 0; g < groups; g++) {
        const o = sub + 16 + g * 12;
        const startChar = v.getUint32(o);
        const endChar = v.getUint32(o + 4);
        const startGid = v.getUint32(o + 8);
        for (let c = startChar; c <= endChar; c++) if (!cmap.has(c)) cmap.set(c, startGid + c - startChar);
      }
    }
  }
  return { bytes, unitsPerEm, ascent, descent, bbox, cmap, advances };
}

export type Weight = 'regular' | 'bold' | 'mono';
export type FontSet = Record<string, TtfFont>;

const isCyr = (cp: number): boolean => (cp >= 0x400 && cp <= 0x4ff) || cp === 0x2116;

interface PdfPage {
  width: number;
  height: number;
  ops: string[];
  images: string[];
}

interface UsedFont {
  key: string;
  name: string;
  font: TtfFont;
  glyphs: Map<number, number>;
}

export interface PageSize {
  width: number;
  height: number;
}

export const A4: PageSize = { width: 595.28, height: 841.89 };
export const A4_LANDSCAPE: PageSize = { width: 841.89, height: 595.28 };
export const A6: PageSize = { width: 297.64, height: 419.53 };

const num = (n: number): string => (Math.round(n * 100) / 100).toString();

function hexColor(c: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (!m) return '0 0 0';
  return [m[1], m[2], m[3]].map((x) => num(parseInt(x!, 16) / 255)).join(' ');
}

const pdfString = (s: string): string => {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp > 0x7e || ch === '(' || ch === ')' || ch === '\\') out += '?';
    else out += ch;
  }
  return `(${out})`;
};

export class PdfDocument {
  private readonly pages: PdfPage[] = [];
  private readonly used = new Map<string, UsedFont>();
  private readonly images: { name: string; width: number; height: number; data: Uint8Array }[] = [];
  page!: PdfPage;

  constructor(
    private readonly fonts: FontSet,
    private readonly info: { title: string; createdAt: string },
  ) {}

  addPage(size: PageSize): void {
    this.page = { width: size.width, height: size.height, ops: [], images: [] };
    this.pages.push(this.page);
  }

  private face(weight: Weight, cp: number): { key: string; font: TtfFont; gid: number } {
    const primary = `${weight}-${isCyr(cp) ? 'cyr' : 'lat'}`;
    for (const key of [primary, `${weight}-lat`, `${weight}-cyr`]) {
      const font = this.fonts[key];
      const gid = font?.cmap.get(cp);
      if (font && gid !== undefined) return { key, font, gid };
    }
    const key = `${weight}-lat`;
    return { key, font: this.fonts[key]!, gid: 0 };
  }

  widthOf(text: string, weight: Weight, size: number): number {
    let w = 0;
    for (const ch of text) {
      const { font, gid } = this.face(weight, ch.codePointAt(0)!);
      w += ((font.advances[gid] ?? 0) / font.unitsPerEm) * size;
    }
    return w;
  }

  text(text: string, x: number, y: number, weight: Weight, size: number, color = '#33291F'): void {
    const baseline = this.page.height - y - size;
    let cx = x;
    let run: { key: string; hex: string } | null = null;
    const flush = (): void => {
      if (!run) return;
      const used = this.used.get(run.key)!;
      this.page.ops.push(
        `BT /${used.name} ${num(size)} Tf ${hexColor(color)} rg 1 0 0 1 ${num(runX)} ${num(baseline)} Tm <${run.hex}> Tj ET`,
      );
      run = null;
    };
    let runX = cx;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const { key, font, gid } = this.face(weight, cp);
      let used = this.used.get(key);
      if (!used) {
        used = { key, name: `F${this.used.size + 1}`, font, glyphs: new Map() };
        this.used.set(key, used);
      }
      used.glyphs.set(gid, cp);
      if (!run || run.key !== key) {
        flush();
        run = { key, hex: '' };
        runX = cx;
      }
      run.hex += gid.toString(16).padStart(4, '0');
      cx += ((font.advances[gid] ?? 0) / font.unitsPerEm) * size;
    }
    flush();
  }

  paragraph(
    text: string,
    box: { x: number; y: number; width: number; align?: 'left' | 'center' },
    weight: Weight,
    size: number,
  ): number {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && this.widthOf(next, weight, size) > box.width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    let y = box.y;
    for (const l of lines) {
      const x = box.x + (box.align === 'center' ? (box.width - this.widthOf(l, weight, size)) / 2 : 0);
      this.text(l, x, y, weight, size);
      y += size * 1.35;
    }
    return y;
  }

  line(x1: number, y1: number, x2: number, y2: number, color = '#D5D3C2', width = 0.5): void {
    const h = this.page.height;
    this.page.ops.push(`${hexColor(color)} RG ${num(width)} w ${num(x1)} ${num(h - y1)} m ${num(x2)} ${num(h - y2)} l S`);
  }

  rect(x: number, y: number, w: number, hgt: number, color: string): void {
    const h = this.page.height;
    this.page.ops.push(`${hexColor(color)} rg ${num(x)} ${num(h - y - hgt)} ${num(w)} ${num(hgt)} re f`);
  }

  bitmap(matrix: boolean[][], x: number, y: number, w: number, hgt: number): void {
    const height = matrix.length;
    const width = matrix[0]?.length ?? 0;
    const stride = Math.ceil(width / 8);
    const data = new Uint8Array(stride * height);
    for (let r = 0; r < height; r++)
      for (let c = 0; c < width; c++) if (!matrix[r]![c]) data[r * stride + (c >> 3)]! |= 0x80 >> (c & 7);
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, width, height, data });
    this.page.images.push(name);
    const h = this.page.height;
    this.page.ops.push(`q ${num(w)} 0 0 ${num(hgt)} ${num(x)} ${num(h - y - hgt)} cm /${name} Do Q`);
  }

  toBytes(): Uint8Array {
    const objects: (string | Uint8Array)[] = [];
    const add = (content: string | Uint8Array): number => {
      objects.push(content);
      return objects.length;
    };
    const stream = (dict: string, data: Uint8Array): Uint8Array => {
      const z = zlibSync(data, { level: 6 });
      const headBytes = enc.encode(`<< ${dict} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`);
      const tail = enc.encode('\nendstream');
      const out = new Uint8Array(headBytes.length + z.length + tail.length);
      out.set(headBytes);
      out.set(z, headBytes.length);
      out.set(tail, headBytes.length + z.length);
      return out;
    };

    const catalog = add('');
    const pagesId = add('');
    const fontRefs: string[] = [];
    for (const u of this.used.values()) {
      const f = u.font;
      const scale = 1000 / f.unitsPerEm;
      const file = add(stream(`/Length1 ${f.bytes.length}`, f.bytes));
      const descriptor = add(
        `<< /Type /FontDescriptor /FontName /AT${u.key.replace('-', '')} /Flags 32 /FontBBox [${f.bbox
          .map((b) => Math.round(b * scale))
          .join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(f.ascent * scale)} /Descent ${Math.round(
          f.descent * scale,
        )} /CapHeight ${Math.round(f.ascent * scale)} /StemV 80 /FontFile2 ${file} 0 R >>`,
      );
      const gids = [...u.glyphs.keys()].sort((a, b) => a - b);
      const widths = gids.map((g) => `${g} [${Math.round((f.advances[g] ?? 0) * scale)}]`).join(' ');
      const cid = add(
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AT${u.key.replace('-', '')} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /W [${widths}] /CIDToGIDMap /Identity >>`,
      );
      const bf = gids
        .map((g) => {
          const cp = u.glyphs.get(g)!;
          const utf16 =
            cp > 0xffff
              ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)]
              : [cp];
          return `<${g.toString(16).padStart(4, '0')}> <${utf16.map((x) => x.toString(16).padStart(4, '0')).join('')}>`;
        })
        .join('\n');
      const cmap = add(
        stream(
          '',
          enc.encode(
            `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${gids.length} beginbfchar\n${bf}\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end`,
          ),
        ),
      );
      const type0 = add(
        `<< /Type /Font /Subtype /Type0 /BaseFont /AT${u.key.replace('-', '')} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${cmap} 0 R >>`,
      );
      fontRefs.push(`/${u.name} ${type0} 0 R`);
    }
    const imageRefs = new Map<string, number>();
    for (const im of this.images)
      imageRefs.set(
        im.name,
        add(
          stream(
            `/Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Interpolate false`,
            im.data,
          ),
        ),
      );
    const pageIds: number[] = [];
    for (const p of this.pages) {
      const content = add(stream('', enc.encode(p.ops.join('\n'))));
      const xobjects = p.images.map((n) => `/${n} ${imageRefs.get(n)} 0 R`).join(' ');
      pageIds.push(
        add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] /Resources << /Font << ${fontRefs.join(' ')} >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> /Contents ${content} 0 R >>`,
        ),
      );
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    const d = this.info.createdAt.replace(/[-:TZ]/g, '').slice(0, 14);
    const infoId = add(
      `<< /Title ${pdfString(this.info.title)} /Author (AgroTrace) /Creator (AgroTrace) /Producer (AgroTrace mock-api) /CreationDate (D:${d}Z) /ModDate (D:${d}Z) >>`,
    );

    const chunks: Uint8Array[] = [enc.encode('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
    let offset = chunks[0]!.length;
    const offsets: number[] = [];
    objects.forEach((o, i) => {
      offsets.push(offset);
      const headBytes = enc.encode(`${i + 1} 0 obj\n`);
      const body = typeof o === 'string' ? enc.encode(o) : o;
      const tail = enc.encode('\nendobj\n');
      chunks.push(headBytes, body, tail);
      offset += headBytes.length + body.length + tail.length;
    });
    const xref = [
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
      ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    ].join('');
    chunks.push(enc.encode(xref));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}
