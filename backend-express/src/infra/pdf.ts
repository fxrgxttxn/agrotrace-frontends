/**
 * Generated PDF documents, laid out like the seed's (db/seed/src/files.ts): the A6 QR label of a batch (createBatchQr,
 * R43: QR, publicCode, product name, origin organization). Text is set in the design-system fonts (Onest, JetBrains
 * Mono — the @fontsource WOFF files: fontkit cannot subset WOFF2); their subsets are split by script, so every line is
 * laid out by hand as runs that switch between the latin and the cyrillic face, wrapped on spaces.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';

type Doc = PDFKit.PDFDocument;
type Weight = 'regular' | 'bold' | 'mono';

// Not `require`: the production bundle (build.mjs) declares that name in its banner.
const resolveModule = createRequire(import.meta.url).resolve;

const FONTS: [key: string, pkg: string, file: string][] = [
  ['regular-cyr', 'onest', 'onest-cyrillic-400-normal'],
  ['regular-lat', 'onest', 'onest-latin-400-normal'],
  ['bold-cyr', 'onest', 'onest-cyrillic-600-normal'],
  ['bold-lat', 'onest', 'onest-latin-600-normal'],
  ['mono-cyr', 'jetbrains-mono', 'jetbrains-mono-cyrillic-500-normal'],
  ['mono-lat', 'jetbrains-mono', 'jetbrains-mono-latin-500-normal'],
];

let fontBytes: Map<string, Buffer> | null = null;

/** The font files, read once per process. */
function fonts(): Map<string, Buffer> {
  fontBytes ??= new Map(
    FONTS.map(([key, pkg, file]) => [
      key,
      readFileSync(resolveModule(`@fontsource/${pkg}/files/${file}.woff`)),
    ]),
  );
  return fontBytes;
}

const isCyr = (c: string): boolean => /[Ѐ-ӿ№]/.test(c);

function splitRuns(text: string): { cyr: boolean; s: string }[] {
  const parts: { cyr: boolean; s: string }[] = [];
  for (const c of text) {
    const last = parts[parts.length - 1];
    const cyr = c === ' ' && last ? last.cyr : isCyr(c);
    if (last && last.cyr === cyr) last.s += c;
    else parts.push({ cyr, s: c });
  }
  return parts;
}

function widthOf(doc: Doc, text: string, weight: Weight, size: number): number {
  return splitRuns(text).reduce(
    (sum, p) =>
      sum +
      doc
        .font(`${weight}-${p.cyr ? 'cyr' : 'lat'}`)
        .fontSize(size)
        .widthOfString(p.s),
    0,
  );
}

/** Draws `text` in a box starting at (x, y); returns the y below the last line. */
function paragraph(
  doc: Doc,
  text: string,
  weight: Weight,
  size: number,
  box: { x: number; y: number; width: number; align?: 'left' | 'center' },
): number {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && widthOf(doc, next, weight, size) > box.width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  let y = box.y;
  for (const l of lines) {
    let x = box.x + (box.align === 'center' ? (box.width - widthOf(doc, l, weight, size)) / 2 : 0);
    for (const p of splitRuns(l)) {
      doc
        .font(`${weight}-${p.cyr ? 'cyr' : 'lat'}`)
        .fontSize(size)
        .fillColor('#33291F');
      doc.text(p.s, x, y, { lineBreak: false });
      x += doc.widthOfString(p.s);
    }
    y += size * 1.35;
  }
  return y;
}

function newDoc(size: string, title: string, createdAt: Date): Doc {
  const doc = new PDFDocument({
    size,
    margin: 28,
    info: {
      Title: title,
      Author: 'AgroTrace',
      Creator: 'AgroTrace',
      Producer: 'AgroTrace express',
      CreationDate: createdAt,
      ModDate: createdAt,
    },
  });
  // pdfkit shares one embedded font per PostScript name, and both script subsets of a face carry the same name:
  // open each once and drop the by-name alias so the next subset gets its own font.
  const families = (doc as unknown as { _fontFamilies: Record<string, unknown> })._fontFamilies;
  for (const [key, bytes] of fonts()) {
    doc.registerFont(key, bytes);
    doc.font(key);
    const name = (doc as unknown as { _font: { name: string } })._font.name;
    if (name !== key) delete families[name];
  }
  return doc;
}

const finish = (doc: Doc): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });

export interface QrLabel {
  publicCode: string;
  productName: string;
  originName: string;
  /** The QR PNG (qr.ts) placed on the label. */
  png: Buffer;
  createdAt: Date;
}

/** A6 label: QR, public code, product, origin organization. */
export function qrLabelPdf(d: QrLabel): Promise<Buffer> {
  const doc = newDoc('A6', `QR ${d.publicCode}`, d.createdAt);
  const width = doc.page.width - 56;
  doc.image(d.png, (doc.page.width - 220) / 2, 24, { width: 220, height: 220 });
  let y = paragraph(doc, d.publicCode, 'mono', 16, { x: 28, y: 252, width, align: 'center' });
  y = paragraph(doc, d.productName, 'bold', 12, { x: 28, y: y + 4, width, align: 'center' });
  y = paragraph(doc, d.originName, 'regular', 9, { x: 28, y: y + 2, width, align: 'center' });
  paragraph(doc, 'Сканируйте, чтобы узнать происхождение партии', 'regular', 8, {
    x: 28,
    y: y + 8,
    width,
    align: 'center',
  });
  return finish(doc);
}
