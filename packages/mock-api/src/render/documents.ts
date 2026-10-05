import { PDF_FONTS } from '../seed/assets.generated.js';
import { A4, A6, parseTtf, PdfDocument, type FontSet } from './pdf.js';
import { qrMatrix } from './png.js';

export type AssetLoader = (url: string) => Promise<Uint8Array>;

let fontCache: Promise<FontSet> | null = null;

export function loadFonts(load: AssetLoader): Promise<FontSet> {
  fontCache ??= (async () => {
    const set: FontSet = {};
    for (const [key, url] of Object.entries(PDF_FONTS)) set[key] = parseTtf(await load(url));
    return set;
  })().catch((e: unknown) => {
    fontCache = null;
    throw e;
  });
  return fontCache;
}

const fmtDate = (t: string | null): string =>
  t ? `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(0, 4)} ${t.slice(11, 16)} UTC` : '—';

const REASON_TEXT: Record<string, string> = {
  PLANNED: 'плановая выборка',
  RISK: 'риск-модель',
  COMPLAINT: 'жалоба покупателя',
  INSPECTOR: 'назначение инспектора',
};

export interface ProtocolData {
  labName: string;
  labInn: string;
  testId: string;
  publicCode: string;
  productName: string;
  customerName: string;
  reason: string;
  sampledAt: string | null;
  completedAt: string | null;
  conclusion: 'PASS' | 'FAIL' | null;
  results: { name: string; unit: string; norm: string; value: string; exceeded: boolean }[];
  createdAt: string;
}

export function protocolPdf(fonts: FontSet, d: ProtocolData): Uint8Array {
  const doc = new PdfDocument(fonts, { title: `Протокол испытаний ${d.publicCode}`, createdAt: d.createdAt });
  doc.addPage(A4);
  const left = 48;
  const width = A4.width - 2 * left;
  let y = doc.paragraph(d.labName, { x: left, y: 48, width }, 'bold', 12);
  y = doc.paragraph(`ИНН ${d.labInn}`, { x: left, y, width }, 'regular', 9);
  y = doc.paragraph(`Протокол испытаний № ${d.testId.slice(0, 8).toUpperCase()}`, { x: left, y: y + 18, width }, 'bold', 16);
  y += 6;
  for (const line of [
    `Партия: ${d.publicCode} — ${d.productName}`,
    `Заказчик: ${d.customerName}`,
    `Основание: ${REASON_TEXT[d.reason] ?? d.reason}`,
    `Отбор пробы: ${fmtDate(d.sampledAt)}; испытания завершены: ${fmtDate(d.completedAt)}`,
  ])
    y = doc.paragraph(line, { x: left, y, width }, 'regular', 11);
  y += 14;
  const cols = [
    { x: left, width: 230 },
    { x: left + 240, width: 95 },
    { x: left + 345, width: 80 },
    { x: left + 435, width: width - 435 },
  ];
  const row = (cells: string[], weight: 'regular' | 'bold'): void => {
    const bottom = Math.max(...cells.map((text, i) => doc.paragraph(text, { x: cols[i]!.x, y, width: cols[i]!.width }, weight, 10)));
    doc.line(left, bottom + 2, left + width, bottom + 2);
    y = bottom + 8;
  };
  row(['Показатель', 'Норматив, не более', 'Результат', 'Оценка'], 'bold');
  for (const r of d.results) row([`${r.name}, ${r.unit}`, r.norm, r.value, r.exceeded ? 'превышение' : 'норма'], 'regular');
  if (d.conclusion) {
    const verdict = d.conclusion === 'PASS' ? 'соответствует требованиям' : 'не соответствует требованиям';
    doc.paragraph(`Заключение: партия ${verdict}.`, { x: left, y: y + 12, width }, 'bold', 12);
  }
  return doc.toBytes();
}

export interface QrLabelData {
  publicCode: string;
  publicUrl: string;
  productName: string;
  originName: string;
  createdAt: string;
}

export function qrLabelPdf(fonts: FontSet, d: QrLabelData): Uint8Array {
  const doc = new PdfDocument(fonts, { title: `QR ${d.publicCode}`, createdAt: d.createdAt });
  doc.addPage(A6);
  const width = A6.width - 56;
  doc.bitmap(qrMatrix(d.publicUrl), (A6.width - 220) / 2, 24, 220, 220);
  let y = doc.paragraph(d.publicCode, { x: 28, y: 252, width, align: 'center' }, 'mono', 16);
  y = doc.paragraph(d.productName, { x: 28, y: y + 4, width, align: 'center' }, 'bold', 12);
  y = doc.paragraph(d.originName, { x: 28, y: y + 2, width, align: 'center' }, 'regular', 9);
  doc.paragraph('Сканируйте, чтобы узнать происхождение партии', { x: 28, y: y + 8, width, align: 'center' }, 'regular', 8);
  return doc.toBytes();
}
