import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { SEED_ROOT } from './data.js';
import type { FileSpec, Row, World } from './world.js';

export const IMAGE_VARIANTS = [96, 480] as const;

export interface StoredObject {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface RenderedFile {
  row: Row;
  objects: StoredObject[];
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const KEY_TYPE: Record<FileSpec['kind'], string> = {
  AVATAR: 'avatar',
  LOGO: 'logo',
  PRODUCT_IMAGE: 'product-image',
  LAB_PROTOCOL: 'lab-protocol',
  QR: 'qr',
};

export function objectKey(spec: FileSpec, variant: string): string {
  const [yyyy, mm] = spec.createdAt.slice(0, 7).split('-');
  return `${KEY_TYPE[spec.kind]}/${yyyy}/${mm}/${spec.id}/${variant}`;
}

const image = (dir: string, name: string): Buffer =>
  readFileSync(new URL(`images/${dir}/${name}`, SEED_ROOT));
const require = createRequire(import.meta.url);
const font = (pkg: string, name: string): Buffer =>
  readFileSync(require.resolve(`@fontsource/${pkg}/files/${name}.woff`));

async function withSeededRandom<T>(seed: string, fn: () => Promise<T>): Promise<T> {
  const original = Math.random;
  let state = createHash('sha256').update(seed).digest().readUInt32BE(0) || 1;
  Math.random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}

type Doc = PDFKit.PDFDocument;
type Weight = 'regular' | 'bold' | 'mono';

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

function newDoc(spec: FileSpec, size: string, title: string): Doc {
  const doc = new PDFDocument({
    size,
    margin: 28,
    info: {
      Title: title,
      Author: 'AgroTrace',
      Creator: 'AgroTrace',
      Producer: 'AgroTrace seed',
      CreationDate: new Date(spec.createdAt),
      ModDate: new Date(spec.createdAt),
    },
  });
  const fonts: [string, string, string][] = [
    ['regular-cyr', 'onest', 'onest-cyrillic-400-normal'],
    ['regular-lat', 'onest', 'onest-latin-400-normal'],
    ['bold-cyr', 'onest', 'onest-cyrillic-600-normal'],
    ['bold-lat', 'onest', 'onest-latin-600-normal'],
    ['mono-cyr', 'jetbrains-mono', 'jetbrains-mono-cyrillic-500-normal'],
    ['mono-lat', 'jetbrains-mono', 'jetbrains-mono-latin-500-normal'],
  ];
  const families = (doc as unknown as { _fontFamilies: Record<string, unknown> })._fontFamilies;
  for (const [key, pkg, file] of fonts) {
    doc.registerFont(key, font(pkg, file));
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

export function publicUrl(base: string, publicCode: string): string {
  return `${base.replace(/\/+$/, '')}/p/${publicCode}`;
}

export function qrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 1024,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}

async function qrLabelPdf(spec: FileSpec & { source: { type: 'qrPdf' } }, png: Buffer): Promise<Buffer> {
  const s = spec.source;
  const doc = newDoc(spec, 'A6', `QR ${s.publicCode}`);
  const width = doc.page.width - 56;
  doc.image(png, (doc.page.width - 220) / 2, 24, { width: 220, height: 220 });
  let y = paragraph(doc, s.publicCode, 'mono', 16, { x: 28, y: 252, width, align: 'center' });
  y = paragraph(doc, s.productName, 'bold', 12, { x: 28, y: y + 4, width, align: 'center' });
  y = paragraph(doc, s.originName, 'regular', 9, { x: 28, y: y + 2, width, align: 'center' });
  paragraph(doc, 'Сканируйте, чтобы узнать происхождение партии', 'regular', 8, {
    x: 28,
    y: y + 8,
    width,
    align: 'center',
  });
  return finish(doc);
}

const fmtDate = (t: unknown): string => {
  const s = String(t);
  return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)} ${s.slice(11, 16)} UTC`;
};

const REASON_TEXT: Record<string, string> = {
  PLANNED: 'плановая выборка',
  RISK: 'риск-модель',
  COMPLAINT: 'жалоба покупателя',
  INSPECTOR: 'назначение инспектора',
};

async function protocolPdf(w: World, spec: FileSpec & { source: { type: 'protocol' } }): Promise<Buffer> {
  const t = w.t.lab_tests.find((x) => x.id === spec.source.testId)!;
  const b = w.batchById(t.batch_id);
  const lab = w.orgById(t.lab_org_id);
  const product = w.productById(b.product_id);
  const results = w.t.lab_results.filter((r) => r.lab_test_id === t.id);
  const doc = newDoc(spec, 'A4', `Протокол испытаний ${b.public_code as string}`);
  const left = 48;
  const width = doc.page.width - 2 * left;
  let y = paragraph(doc, lab.name as string, 'bold', 12, { x: left, y: 48, width });
  y = paragraph(doc, `ИНН ${lab.inn as string}`, 'regular', 9, { x: left, y, width });
  y = paragraph(doc, `Протокол испытаний № ${(t.id as string).slice(0, 8).toUpperCase()}`, 'bold', 16, {
    x: left,
    y: y + 18,
    width,
  });
  y += 6;
  for (const line of [
    `Партия: ${b.public_code as string} — ${product.name as string}`,
    `Заказчик: ${w.orgById(b.origin_org_id).name as string}`,
    `Основание: ${REASON_TEXT[t.reason as string] ?? (t.reason as string)}`,
    `Отбор пробы: ${fmtDate(t.sampled_at)}; испытания завершены: ${fmtDate(t.completed_at)}`,
  ]) {
    y = paragraph(doc, line, 'regular', 11, { x: left, y, width });
  }
  y += 14;
  const cols = [
    { x: left, width: 230 },
    { x: left + 240, width: 95 },
    { x: left + 345, width: 80 },
    { x: left + 435, width: width - 435 },
  ];
  const row = (cells: string[], weight: Weight): void => {
    const bottom = Math.max(
      ...cells.map((text, i) =>
        paragraph(doc, text, weight, 10, { x: cols[i]!.x, y, width: cols[i]!.width }),
      ),
    );
    doc
      .moveTo(left, bottom + 2)
      .lineTo(left + width, bottom + 2)
      .lineWidth(0.5)
      .strokeColor('#D5D3C2')
      .stroke();
    y = bottom + 8;
  };
  row(['Показатель', 'Норматив, не более', 'Результат', 'Оценка'], 'bold');
  for (const r of results) {
    const ind = w.t.indicators.find((i) => i.id === r.indicator_id)!;
    row(
      [
        `${ind.name as string}, ${ind.unit as string}`,
        r.norm_value_snapshot as string,
        r.value as string,
        r.is_exceeded ? 'превышение' : 'норма',
      ],
      'regular',
    );
  }
  const verdict = t.conclusion === 'PASS' ? 'соответствует требованиям' : 'не соответствует требованиям';
  paragraph(doc, `Заключение: партия ${verdict}.`, 'bold', 12, { x: left, y: y + 12, width });
  return finish(doc);
}

async function variants(spec: FileSpec, original: Buffer): Promise<{ meta: Row; objects: StoredObject[] }> {
  const meta: Row = {};
  const objects: StoredObject[] = [];
  for (const size of IMAGE_VARIANTS) {
    const body = await sharp(original)
      .rotate()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    const key = objectKey(spec, String(size));
    meta[String(size)] = { key, sha256: sha256(body), size: body.length };
    objects.push({ key, body, contentType: 'image/webp' });
  }
  return { meta, objects };
}

export async function renderFiles(w: World, bucket: string): Promise<StoredObject[]> {
  const all: StoredObject[] = [];
  const pngByCode = new Map<string, Buffer>();
  for (const spec of w.files) {
    let body: Buffer;
    let mime: string;
    let extra: { meta: Row; objects: StoredObject[] } = { meta: {}, objects: [] };
    const s = spec.source;
    switch (s.type) {
      case 'productPhoto':
        body = image('products', s.file);
        mime = 'image/jpeg';
        extra = await variants(spec, body);
        break;
      case 'avatar':
        body = image('avatars', `${s.name}.jpg`);
        mime = 'image/jpeg';
        extra = await variants(spec, body);
        break;
      case 'logo':
        body = image('logos', `${s.orgKey}.svg`);
        mime = 'image/svg+xml';
        break;
      case 'qrPng':
        body = await qrPng(publicUrl(w.publicBaseUrl, s.publicCode));
        pngByCode.set(s.publicCode, body);
        mime = 'image/png';
        break;
      case 'qrPdf': {
        const png = pngByCode.get(s.publicCode) ?? (await qrPng(publicUrl(w.publicBaseUrl, s.publicCode)));
        body = await withSeededRandom(spec.id, () =>
          qrLabelPdf(spec as FileSpec & { source: { type: 'qrPdf' } }, png),
        );
        mime = 'application/pdf';
        break;
      }
      case 'protocol':
        body = await withSeededRandom(spec.id, () =>
          protocolPdf(w, spec as FileSpec & { source: { type: 'protocol' } }),
        );
        mime = 'application/pdf';
        break;
    }
    const key = objectKey(spec, 'original');
    const row = w.t.files.find((f) => f.id === spec.id)!;
    for (const k of Object.keys(row)) delete row[k];
    Object.assign(row, {
      id: spec.id,
      bucket,
      object_key: key,
      original_name: spec.originalName,
      mime,
      size_bytes: body.length,
      sha256: sha256(body),
      variants: extra.meta,
      kind: spec.kind,
      owner_id: spec.ownerId,
      created_at: spec.createdAt,
      deleted_at: null,
    });
    all.push({ key, body, contentType: mime }, ...extra.objects);
  }
  return all;
}
