/**
 * P23/P24: the XLSX import reader. The API thread checks only the ZIP directory; everything else runs in a worker
 * thread behind a bounded queue with a deadline and a heap limit. tests/api cannot see inside the process (event-loop
 * lag, the worker being killed, temp files), so these properties are proven here on the reader itself — every
 * pathological input with a wall-clock bound and the main event loop staying responsive.
 */
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { crc32, deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProblem } from '../src/http/problem.js';
import { WorkerQueue, type Engine } from '../src/infra/worker-queue.js';
import { storedZip, unzip, ZipError, type ZipEntry } from '../src/infra/zip.js';
import { readSheet, TOO_LONG, xlsxWorkerEngine } from '../src/modules/dictionaries/sheet.js';
import { XLSX_ZIP_LIMITS } from '../src/modules/dictionaries/xlsx-read.js';
import { prescanSheet, scanXml } from '../src/modules/dictionaries/xlsx-scan.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MiB = 1024 * 1024;
const WB = `<workbook xmlns="${NS}" xmlns:r="${R_NS}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS = `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const HDR = '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>';

interface Part {
  name: string;
  data: string | Buffer;
  /** Deflate the entry and declare this uncompressed size (a lie when it differs from the data). */
  declared?: number;
}

/** A ZIP of parts; parts with `declared` are deflated with that declared size. */
function zipOf(parts: Part[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const name = Buffer.from(p.name);
    const data = typeof p.data === 'string' ? Buffer.from(p.data) : p.data;
    const deflate = p.declared !== undefined;
    const body = deflate ? deflateRawSync(data) : data;
    const size = p.declared ?? data.length;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(deflate ? 8 : 0, 8);
    l.writeUInt32LE(crc32(data), 14);
    l.writeUInt32LE(body.length, 18);
    l.writeUInt32LE(size, 22);
    l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(l, name, body);
    centrals.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A hand-made workbook; `rows` is the `<sheetData>` content. */
function book(o: { rows?: string; wb?: string; rels?: string; sst?: string; extra?: Part[] } = {}): Buffer {
  return zipOf([
    {
      name: '[Content_Types].xml',
      data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    { name: 'xl/workbook.xml', data: o.wb ?? WB },
    { name: 'xl/_rels/workbook.xml.rels', data: o.rels ?? RELS },
    ...(o.sst !== undefined ? [{ name: 'xl/sharedStrings.xml', data: o.sst }] : []),
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<worksheet xmlns="${NS}"><sheetData>${o.rows ?? HDR}</sheetData></worksheet>`,
    },
    ...(o.extra ?? []),
  ]);
}

const column = (n: number) => {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** The problem `p` rejects with (or null when it resolves). */
async function outcome(p: Promise<unknown>): Promise<AppProblem | null> {
  try {
    await p;
    return null;
  } catch (err) {
    if (err instanceof AppProblem) return err;
    throw err;
  }
}

const reasonOf = (p: AppProblem | null) =>
  p === null ? 'ok' : `${p.status} ${(p.extras.params as { reason?: string } | undefined)?.reason ?? p.code}`;

// Main event-loop lag while a test runs (the parsing must never block the API thread).
let maxLag = 0;
let last = 0;
let lagTimer: NodeJS.Timeout;
/** Starts measuring afresh (building a test input synchronously is not the reader's lag). */
const resetLag = () => {
  maxLag = 0;
  last = Date.now();
};
beforeEach(() => {
  resetLag();
  lagTimer = setInterval(() => {
    const now = Date.now();
    maxLag = Math.max(maxLag, now - last - 10);
    last = now;
  }, 10);
});
afterEach(() => clearInterval(lagTimer));

/** Reads `bytes`, asserting a wall-clock bound; returns the outcome as "ok" / "415 workbook-too-large" / …. */
async function timed(bytes: Buffer, boundMs: number): Promise<string> {
  resetLag();
  const started = Date.now();
  const r = reasonOf(await outcome(readSheet(bytes)));
  expect(Date.now() - started, r).toBeLessThan(boundMs);
  return r;
}

describe('warm-up', () => {
  it('both lanes start their workers (start-up is never charged to a job)', async () => {
    expect(await timed(book(), 60_000)).toBe('ok');
    expect(await timed(book({ extra: [{ name: 'x/pad.bin', data: Buffer.alloc(70 * 1024) }] }), 60_000)).toBe(
      'ok',
    );
  }, 90_000);
});

describe('ZIP directory (API thread) and inflate checks (worker)', () => {
  it('64 entries accepted, 65 refused; declared > 16 MiB per entry or > 32 MiB in all refused', async () => {
    const pad = (k: number) => Array.from({ length: k }, (_, i) => ({ name: `x/${i}.xml`, data: '<x/>' }));
    expect(await timed(book({ extra: pad(60) }), 3000)).toBe('ok'); // 4 + 60
    expect(await timed(book({ extra: pad(61) }), 3000)).toBe('415 workbook-too-large');
    expect(
      await timed(book({ extra: [{ name: 'x/big.bin', data: Buffer.alloc(16 * MiB + 1) }] }), 3000),
    ).toBe('415 workbook-too-large');
    const eleven = Buffer.alloc(11 * MiB);
    const three = ['a', 'b', 'c'].map((n) => ({ name: `x/${n}.bin`, data: eleven }));
    expect(await timed(book({ extra: three }), 3000)).toBe('415 workbook-too-large');
  });

  it('part caps: the workbook part, its relationships or styles over 1 MiB → too large', async () => {
    const big = `${WB}<!--${'x'.repeat(MiB)}-->`;
    expect(await timed(book({ wb: big }), 3000)).toBe('415 workbook-too-large');
    const styles = { name: 'xl/styles.xml', data: `<styleSheet xmlns="${NS}"/>${' '.repeat(MiB)}` };
    expect(await timed(book({ extra: [styles] }), 3000)).toBe('415 workbook-too-large');
  });

  it('a bomb in an entry nobody reads is found (every entry is inflate-checked), in bounded time', async () => {
    const bomb = { name: 'x/bomb.bin', data: Buffer.alloc(64 * MiB), declared: 10 };
    expect(await timed(book({ extra: [bomb] }), 3000)).toBe('415 workbook-too-large');
    const wanted = zipOf([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: WB },
      { name: 'xl/_rels/workbook.xml.rels', data: RELS },
      { name: 'xl/sharedStrings.xml', data: Buffer.alloc(64 * MiB, 0x20), declared: 1000 },
      { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${HDR}</sheetData></worksheet>` },
    ]);
    expect(await timed(wanted, 3000)).toBe('415 workbook-too-large');
    expect(() =>
      unzip(zipOf([{ name: 'a', data: Buffer.alloc(MiB), declared: 10 }]), XLSX_ZIP_LIMITS, () => false),
    ).toThrow(ZipError);
    expect(maxLag).toBeLessThan(100);
  });

  it('a ZIP that is not a workbook → 415 without reason', async () => {
    const notBook = storedZip([
      { name: 'word/document.xml', data: Buffer.from('<w/>') },
      { name: '[Content_Types].xml', data: Buffer.from('<T/>') },
    ]);
    expect(await timed(notBook, 3000)).toBe('415 UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('pre-scan limits (cells = <c> elements per row; no cell beyond column 64)', () => {
  const cells = (r: number, n: number, attrs = '') =>
    Array.from({ length: n }, (_, i) => `<c r="${column(i + 1)}${r}"${attrs}><v>1</v></c>`).join('');

  it('20 000 <row> elements (empty ones included) read, one more → too large', async () => {
    const empty = (n: number) => Array.from({ length: n }, (_, i) => `<row r="${i + 2}"/>`).join('');
    expect(await timed(book({ rows: HDR + empty(19_999) }), 5000)).toBe('ok');
    expect(await timed(book({ rows: HDR + empty(20_000) }), 5000)).toBe('415 workbook-too-large');
  });

  it('64 <c> read; 65 <c> (styled empty ones count too) or a value in column 65 → too large', async () => {
    expect(await timed(book({ rows: `<row r="1">${cells(1, 64)}</row>` }), 3000)).toBe('ok');
    expect(await timed(book({ rows: `<row r="1">${cells(1, 65)}</row>` }), 3000)).toBe(
      '415 workbook-too-large',
    );
    const styled = `<row r="1"><c r="A1"><v>1</v></c>${Array.from({ length: 64 }, (_, i) => `<c r="${column(i + 2)}1" s="1"/>`).join('')}</row>`;
    expect(await timed(book({ rows: styled }), 3000)).toBe('415 workbook-too-large');
    expect(await timed(book({ rows: `<row r="1"><c r="BM1"><v>1</v></c></row>` }), 3000)).toBe(
      '415 workbook-too-large',
    );
    expect(await timed(book({ rows: `<row r="1"><c r="BL1"><v>1</v></c></row>` }), 3000)).toBe('ok');
  });

  it('more than 200 000 shared strings or rich-text runs → too large', async () => {
    const si = (n: number) => `<sst xmlns="${NS}">${'<si><t>x</t></si>'.repeat(n)}</sst>`;
    expect(await timed(book({ sst: si(200_000) }), 8000)).toBe('ok');
    expect(await timed(book({ sst: si(200_001) }), 3000)).toBe('415 workbook-too-large');
    const runs = `<sst xmlns="${NS}"><si>${'<r><t>x</t></r>'.repeat(200_001)}</si></sst>`;
    expect(await timed(book({ sst: runs }), 3000)).toBe('415 workbook-too-large');
  }, 30_000);

  it('the scanner is linear: 64 000 unclosed tags or 4 M empty cells are refused in milliseconds', () => {
    const started = Date.now();
    expect(() =>
      scanXml(
        `<sheets>${'<sheet'.repeat(64_000)}`,
        () => true,
        () => undefined,
      ),
    ).toThrow();
    expect(() => prescanSheet(`<row r="1">${'<c/>'.repeat(4_000_000)}</row>`)).toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/** A shared-strings table of one string `s`, referenced by every cell of `rows` × `cols` (after the header). */
function amplified(s: string, rows: number, cols: number): Buffer {
  const cell = (k: number, r: number) => `<c r="${column(k + 1)}${r}" t="s"><v>0</v></c>`;
  const body = Array.from(
    { length: rows },
    (_, i) => `<row r="${i + 2}">${Array.from({ length: cols }, (_, k) => cell(k, i + 2)).join('')}</row>`,
  );
  return book({ sst: `<sst xmlns="${NS}"><si><t>${s}</t></si></sst>`, rows: HDR + body.join('') });
}

describe('pathological workbooks: bounded time, the exact outcome, the API thread stays responsive', () => {
  const MB16 = 16 * MiB - 400;
  const TOO_LARGE = '415 workbook-too-large';
  const REFUSED = '415 UNSUPPORTED_MEDIA_TYPE';
  const cases: Record<string, [() => Buffer, string]> = {
    redosWorkbook: [
      () => book({ wb: `<workbook xmlns="${NS}" xmlns:r="${R_NS}"><sheets>${'<sheet'.repeat(64_000)}` }),
      REFUSED,
    ],
    redosRels: [() => book({ rels: '<Relationship'.repeat(64_000) }), REFUSED],
    // `<c>` without `r` is refused at the first one (P25), whatever follows.
    emptyCells: [() => book({ rows: `<row r="1">${'<c/>'.repeat(4_000_000)}</row>` }), REFUSED],
    wideRowHuge: [() => book({ rows: `<row r="1">${'<c><v>1</v></c>'.repeat(1_000_000)}</row>` }), REFUSED],
    wideRowWithRefs: [
      () =>
        book({
          rows: `<row r="1">${Array.from({ length: 70 }, (_, i) => `<c r="${column(i + 1)}1"><v>1</v></c>`).join('')}</row>`,
        }),
      TOO_LARGE,
    ],
    sstRich: [
      () => {
        const u =
          '<si><r><rPr><b/><i/><u/><sz val="1"/><color rgb="FF000000"/><rFont val="A"/></rPr><t>x</t></r></si>';
        return book({ sst: `<sst xmlns="${NS}">${u.repeat(Math.floor(MB16 / u.length))}</sst>` });
      },
      'ok',
    ],
    sstRuns: [
      () =>
        book({ sst: `<sst xmlns="${NS}"><si>${'<r><t>x</t></r>'.repeat(Math.floor(MB16 / 15))}</si></sst>` }),
      TOO_LARGE,
    ],
    // A 15 MiB cell: its text never leaves the worker (P25 cap), the row reports maxLength.
    bigCell: [
      () =>
        book({
          rows: `${HDR}<row r="2"><c r="A2" t="inlineStr"><is><t>${'x'.repeat(15 * MiB)}</t></is></c></row>`,
        }),
      'ok',
    ],
    // One 1 MiB shared string referenced by 18 000 cells: nothing of it crosses to the API thread (P25).
    sharedStringAmplified: [() => amplified('x'.repeat(MiB), 9000, 2), 'ok'],
    // 999-character strings (under the cell cap) × 9 000 × 64 cells: over the 8 MiB result cap.
    resultOverEightMiB: [() => amplified('ж'.repeat(999), 9000, 64), TOO_LARGE],
  };
  /** Both lanes have a live worker (a previous case may have killed one at its heap limit — by design). */
  const warm = async () => {
    await readSheet(book());
    await readSheet(book({ extra: [{ name: 'x/pad.bin', data: Buffer.alloc(70 * 1024) }] }));
  };
  it.each(Object.keys(cases))(
    '%s',
    async (name) => {
      await warm(); // a worker's start-up is not part of any job's bound
      const [build, expected] = cases[name]!;
      const bytes = build();
      const heapBefore = process.memoryUsage().heapUsed;
      const r = await timed(bytes, 12_000); // the 10 s deadline + slack
      expect(r).toBe(expected);
      expect(maxLag, `event-loop lag while reading ${name}`).toBeLessThan(100);
      // The API thread holds the (bounded) result only: far below the amplified sizes.
      expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * MiB);
    },
    90_000,
  );

  it('a 1 MiB shared string in 18 000 cells reaches the API thread as "too long" markers only', async () => {
    const sheet = await readSheet(amplified('x'.repeat(MiB), 9000, 2));
    expect(sheet.rows).toHaveLength(9000);
    expect(sheet.rows[0]!.cells).toEqual([TOO_LONG, TOO_LONG]);
  }, 90_000);
});

describe('exact text: multi-byte characters across chunk boundaries (P25)', () => {
  it('3 000 Cyrillic rows (> 64 KiB of sheet and shared strings) read back exactly', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Регионы');
    ws.addRow(['code', 'name']);
    const expected: string[][] = [];
    for (let i = 0; i < 3000; i++) {
      const row = [`К-${i}`, `Ёжиковая область №${i} — «Щёлково» ${'ЖЩЫ'.repeat(i % 7)}`];
      ws.addRow(row);
      expected.push(row);
    }
    const sheet = await readSheet(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(sheet.rows.map((r) => r.cells)).toEqual(expected);
    // An inline-string sheet > 64 KiB (no shared strings): the sheet part itself is cut into chunks.
    const inline = expected
      .map(
        (r, i) =>
          `<row r="${i + 2}">${r.map((v, k) => `<c r="${column(k + 1)}${i + 2}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`,
      )
      .join('');
    const again = await readSheet(book({ rows: HDR + inline }));
    expect(again.rows.map((r) => r.cells)).toEqual(expected);
  }, 90_000);
});

describe('P25 structure rules and the order of checks', () => {
  const refused = '415 UNSUPPORTED_MEDIA_TYPE';
  const tooLarge = '415 workbook-too-large';
  const read = async (b: Buffer) => reasonOf(await outcome(readSheet(b)));
  /** The ZIP with the CRC of entry `name` broken (central directory and local header). */
  const badCrc = (b: Buffer, name: string) => {
    const out = Buffer.from(b);
    const n = Buffer.from(name);
    for (let p = out.indexOf(n); p >= 0; p = out.indexOf(n, p + 1)) {
      if (p >= 46 && out.readUInt32LE(p - 46) === 0x02014b50)
        out.writeUInt32LE(out.readUInt32LE(p - 30) ^ 1, p - 30);
      if (p >= 30 && out.readUInt32LE(p - 30) === 0x04034b50)
        out.writeUInt32LE(out.readUInt32LE(p - 16) ^ 1, p - 16);
    }
    return out;
  };

  it('missing `r` on a row or a cell, a cell outside a row, prefixed SpreadsheetML elements → 415 {allowed}', async () => {
    expect(await read(book({ rows: '<row><c r="A1"><v>1</v></c></row>' }))).toBe(refused);
    expect(await read(book({ rows: '<row r="1"><c><v>1</v></c></row>' }))).toBe(refused);
    expect(await read(book({ rows: `${HDR}<c r="A2"><v>1</v></c>` }))).toBe(refused);
    const prefixed = zipOf([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: WB },
      { name: 'xl/_rels/workbook.xml.rels', data: RELS },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: `<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
      },
    ]);
    expect(await read(prefixed)).toBe(refused);
  });

  it('an entry whose CRC does not match, or that inflates to less than declared → 415 {allowed}', async () => {
    expect(await read(badCrc(book(), 'xl/worksheets/sheet1.xml'))).toBe(refused);
    const short = zipOf([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: WB },
      { name: 'xl/_rels/workbook.xml.rels', data: RELS },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: `<worksheet><sheetData>${HDR}</sheetData></worksheet>`,
        declared: 5000,
      },
    ]);
    expect(await read(short)).toBe(refused);
  });

  it('order: directory → inflate/CRC of every entry → pre-scan (sheet, then shared strings) → rows → header', async () => {
    const pad = Array.from({ length: 61 }, (_, i) => ({ name: `x/${i}.xml`, data: '<x/>' }));
    // 65 entries (directory) beat a bad CRC.
    expect(await read(badCrc(book({ extra: pad }), 'xl/worksheets/sheet1.xml'))).toBe(tooLarge);
    // A bad CRC anywhere beats a pre-scan violation of the sheet.
    const wide = `<row r="1">${Array.from({ length: 65 }, (_, i) => `<c r="${column(i + 1)}1"><v>1</v></c>`).join('')}</row>`;
    expect(
      await read(badCrc(book({ rows: wide, extra: [{ name: 'x/a.xml', data: '<a/>' }] }), 'x/a.xml')),
    ).toBe(refused);
    // The sheet is scanned before the shared strings: a sheet violation wins either way.
    const sstTooMany = `<sst xmlns="${NS}">${'<si><t>x</t></si>'.repeat(200_001)}</sst>`;
    expect(await read(book({ rows: '<row r="1"><c><v>1</v></c></row>', sst: sstTooMany }))).toBe(refused);
    const sstPrefixed = `<x:sst xmlns:x="${NS}"><x:si><x:t>a</x:t></x:si></x:sst>`;
    expect(await read(book({ rows: wide, sst: sstPrefixed }))).toBe(tooLarge);
    // tooManyRows (400) comes from reading, before any header check (the header here is wrong too).
    const many = Array.from(
      { length: 10_001 },
      (_, i) => `<row r="${i + 2}"><c r="A${i + 2}"><v>1</v></c></row>`,
    ).join('');
    expect(await read(book({ rows: many }))).toBe('400 VALIDATION');
  }, 30_000);
});

describe('a large legitimate workbook fits the worker heap', () => {
  it('5 000 rows × 64 cells (with references) read in bounded time; the API thread stays free', async () => {
    let rows = '<row r="1"><c r="A1"><v>1</v></c></row>';
    for (let r = 2; r <= 5000; r++)
      rows += `<row r="${r}">${Array.from({ length: 64 }, (_, i) => `<c r="${column(i + 1)}${r}"><v>1</v></c>`).join('')}</row>`;
    const bytes = book({ rows });
    await readSheet(book({ extra: [{ name: 'x/pad.bin', data: Buffer.alloc(70 * 1024) }] })); // the lane is warm
    resetLag();
    const started = Date.now();
    const sheet = await readSheet(bytes);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(sheet.rows).toHaveLength(4999);
    expect(sheet.rows[0]!.cells).toHaveLength(64);
    expect(maxLag).toBeLessThan(100);
  }, 90_000);
});

describe('the deadline terminates the worker', () => {
  it('a job past its deadline → too large; the worker is terminated and replaced; the loop stays free', async () => {
    let created = 0;
    let terminated = 0;
    const factory = (): Engine<Buffer, ArrayBuffer> => {
      created += 1;
      const e = xlsxWorkerEngine();
      return {
        ...e,
        terminate: () => {
          terminated += 1;
          e.terminate();
        },
      };
    };
    const q = new WorkerQueue(factory, { maxWaiting: 8, deadlineMs: 300 }); // > the 100 ms respawn back-off
    let rows = HDR;
    for (let r = 2; r <= 9000; r++)
      rows += `<row r="${r}">${Array.from({ length: 64 }, (_, i) => `<c r="${column(i + 1)}${r}"><v>1</v></c>`).join('')}</row>`;
    const slow = book({ rows });
    // Warm the engine first: its start-up is not charged to a job, so only the job itself is timed below.
    expect(reasonOf(await outcome(readSheet(book(), { queue: q })))).toBe('ok');
    resetLag();
    const started = Date.now();
    expect(reasonOf(await outcome(readSheet(slow, { queue: q })))).toBe('415 workbook-too-large');
    expect(Date.now() - started).toBeLessThan(1500); // 300 ms deadline, then the worker is gone
    expect(terminated).toBe(1);
    expect(maxLag).toBeLessThan(100);
    // The next job runs on a fresh worker.
    expect(reasonOf(await outcome(readSheet(book(), { queue: q })))).toBe('ok');
    expect(created).toBe(2);
  }, 90_000);
});

describe('no temporary files', () => {
  /** An exceljs workbook re-stored in Excel's part order: the sheets first, shared strings and rels last. */
  async function excelOrdered(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const a = wb.addWorksheet('Первый');
    a.addRow(['code', 'name']);
    a.addRow(['T-1', 'Строка']);
    const b = wb.addWorksheet('Второй');
    b.addRow(['other', 'sheet']);
    const parts = unzip(Buffer.from(await wb.xlsx.writeBuffer()), XLSX_ZIP_LIMITS, () => true);
    const rank = (n: string) =>
      n.startsWith('xl/worksheets/') ? 0 : n.includes('sharedStrings') || n.includes('_rels') ? 2 : 1;
    return storedZip([...parts].sort((x, y) => rank(x.name) - rank(y.name)) as ZipEntry[]);
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
    const broken = book({ rows: '<row r="1"><c r="A1" t="s"><v>1</v></c></row><row r="2"><c' });
    expect((await outcome(readSheet(broken)))?.status).toBe(415);
    expect([...temps()].filter((f) => !before.has(f))).toEqual([]);
  });
});
