/**
 * P23: the XLSX import is read in memory within hard limits and never writes a temporary file. tests/api cannot see
 * inside the process (temp files, what is inflated), so these limits are proven here on the reader itself.
 */
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateRawSync, crc32 } from 'node:zlib';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { AppProblem } from '../src/http/problem.js';
import { storedZip, unzip, ZipError, type ZipEntry } from '../src/infra/zip.js';
import { readSheet, XLSX_LIMITS } from '../src/modules/dictionaries/sheet.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MiB = 1024 * 1024;

const entry = (name: string, text: string | Buffer): ZipEntry => ({
  name,
  data: typeof text === 'string' ? Buffer.from(text, 'utf8') : text,
});

/** A hand-made workbook with one sheet whose `<sheetData>` is `rows`; `extra` entries are appended. */
function workbook(rows: string, extra: ZipEntry[] = []): Buffer {
  return storedZip([
    entry(
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    ),
    entry(
      'xl/workbook.xml',
      `<workbook xmlns="${NS}" xmlns:r="${R_NS}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    entry(
      'xl/_rels/workbook.xml.rels',
      `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    entry('xl/worksheets/sheet1.xml', `<worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`),
    ...extra,
  ]);
}

const numberRow = (r: number, values: number[]) =>
  `<row r="${r}">${values.map((v, i) => `<c r="${column(i + 1)}${r}"><v>${v}</v></c>`).join('')}</row>`;

function column(n: number): string {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

async function problemOf(p: Promise<unknown>): Promise<AppProblem> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppProblem) return err;
    throw err;
  }
  throw new Error('expected a problem');
}

const expectTooLarge = async (p: Promise<unknown>) => {
  const problem = await problemOf(p);
  expect(problem.status).toBe(415);
  expect(problem.extras.params).toMatchObject({ reason: 'workbook-too-large' });
};

/** A ZIP with one deflated entry `name` whose headers declare `declared` uncompressed bytes. */
function lyingZip(name: string, data: Buffer, declared: number): Buffer {
  const deflated = deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(declared, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(declared, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const body = Buffer.concat([local, nameBuf, deflated]);
  const cd = Buffer.concat([central, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eocd]);
}

describe('ZIP limits (declared and inflated)', () => {
  it('more than 64 entries → workbook-too-large', async () => {
    const many = Array.from({ length: 62 }, (_, i) => entry(`x/${i}.xml`, '<x/>'));
    await expect(readSheet(workbook(numberRow(1, [1]), many.slice(0, 60)))).resolves.toBeDefined(); // 64 entries
    await expectTooLarge(readSheet(workbook(numberRow(1, [1]), many.slice(0, 61)))); // 65
  });

  it('an entry declaring more than 16 MiB, or 32 MiB in all → workbook-too-large', async () => {
    await expectTooLarge(readSheet(workbook('', [entry('x/big.bin', Buffer.alloc(16 * MiB + 1))])));
    const eleven = Buffer.alloc(11 * MiB);
    await expectTooLarge(
      readSheet(workbook('', [entry('x/a.bin', eleven), entry('x/b.bin', eleven), entry('x/c.bin', eleven)])),
    );
  });

  it('an entry inflating beyond its declared size is cut at the declared size and refused', () => {
    // 64 MiB of zeros deflate to ~64 KB; the directory claims 10 bytes.
    const bomb = lyingZip('xl/sharedStrings.xml', Buffer.alloc(64 * MiB), 10);
    expect(() => unzip(bomb, XLSX_LIMITS.zip, () => true)).toThrow(ZipError);
    try {
      unzip(bomb, XLSX_LIMITS.zip, () => true);
    } catch (err) {
      expect((err as ZipError).kind).toBe('tooLarge');
    }
  });

  it('a ZIP that is not a workbook, or a broken one → 415 without reason', async () => {
    const notBook = storedZip([entry('word/document.xml', '<w/>'), entry('[Content_Types].xml', '<T/>')]);
    const p = await problemOf(readSheet(notBook));
    expect(p.status).toBe(415);
    expect(p.extras.params).not.toHaveProperty('reason');
  });
});

describe('sheet limits', () => {
  it('20 000 <row> elements (empty ones included) are read, one more → workbook-too-large', async () => {
    const empty = (n: number) => Array.from({ length: n }, (_, i) => `<row r="${i + 2}"/>`).join('');
    const ok = await readSheet(workbook(numberRow(1, [1, 2]) + empty(19_999)));
    expect(ok.header).toEqual(['1', '2']);
    await expectTooLarge(readSheet(workbook(numberRow(1, [1, 2]) + empty(20_000))));
  });

  it('64 cells in a row are read, a cell in column 65 → workbook-too-large', async () => {
    const ok = await readSheet(
      workbook(
        numberRow(
          1,
          Array.from({ length: 64 }, (_, i) => i),
        ),
      ),
    );
    expect(ok.header).toHaveLength(64);
    await expectTooLarge(readSheet(workbook(`<row r="1"><c r="${column(65)}1"><v>1</v></c></row>`)));
  });

  it('the deadline → workbook-too-large', async () => {
    await expectTooLarge(readSheet(workbook(numberRow(1, [1])), { deadlineMs: 0 }));
  });
});

describe('no temporary files (exceljs buffers sheets stored before the shared strings)', () => {
  /** An exceljs workbook re-stored in Excel's part order: the sheets first, shared strings and rels last. */
  async function excelOrdered(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const a = wb.addWorksheet('Первый');
    a.addRow(['code', 'name']);
    a.addRow(['T-1', 'Строка']);
    const b = wb.addWorksheet('Второй');
    b.addRow(['other', 'sheet']);
    const parts = unzip(Buffer.from(await wb.xlsx.writeBuffer()), XLSX_LIMITS.zip, () => true);
    const rank = (n: string) =>
      n.startsWith('xl/worksheets/') ? 0 : n.includes('sharedStrings') || n.includes('_rels') ? 2 : 1;
    return storedZip([...parts].sort((x, y) => rank(x.name) - rank(y.name)));
  }
  const temps = () => new Set(readdirSync(tmpdir()));

  it('an Excel-ordered two-sheet workbook: the first sheet is read, nothing is left in the temp directory', async () => {
    const before = temps();
    const sheet = await readSheet(await excelOrdered());
    expect(sheet.header).toEqual(['code', 'name']);
    expect(sheet.rows).toEqual([{ number: 2, cells: ['T-1', 'Строка'] }]);
    expect([...temps()].filter((f) => !before.has(f))).toEqual([]);
  });

  it('a workbook failing to parse: 415, nothing left in the temp directory', async () => {
    const before = temps();
    const broken = workbook('<row r="1"><c r="A1" t="s"><v>1</v></c></row><row r="2"><c');
    const p = await problemOf(readSheet(broken));
    expect(p.status).toBe(415);
    expect([...temps()].filter((f) => !before.has(f))).toEqual([]);
  });
});
