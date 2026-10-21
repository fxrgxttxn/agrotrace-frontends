/**
 * Reports GET /reports/{type} (contracts/openapi/paths/reports.yaml; FR-ANL-04, FR-ANL-05): access by
 * `x-report-access` (roles — the whole system, headRoles — an organization head, own organization only), parameter
 * rules, 404, file names and headers, and the XLSX contents read back with ExcelJS: sheet names and order, the bold
 * header row, columns, row order, cell types (texts — strings; counts — numbers `0`; masses — numbers `0.000`;
 * hours — numbers `0.00`; moments — `YYYY-MM-DD HH:MM` UTC truncated to the minute; booleans да/нет; null — empty).
 * Expected rows come from read-only SQL over the shared DB or from data built here, so the suite holds on any backend.
 * PDF: media type, file name and a PDF signature (the bytes differ between implementations).
 *
 * The row limit (P50): the test stand runs with REPORT_MAX_ROWS = 13 (docker-compose.api-test.yml; the contract's
 * default is 50 000), so the boundary is tested with data built here — 13 rows → 200, 14 → 400 — in the first sheet and
 * in a later one. Reports over the whole system therefore use a window chosen by SQL (a past day with 1…13 rows, see
 * `quietDay`); a head's reports use fresh organizations.
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { loginAs, type Role } from './lib/auth.js';
import { api, type ApiClient } from './lib/client.js';
import { expectContract } from './lib/contract.js';
import { dbNow, fixtureWrite, query } from './lib/db.js';
import { expectErrors, expectProblem } from './lib/expect.js';
import { acceptWaybill, freshOrg, sentWaybill } from './lib/production.js';
import {
  confirmTask,
  createRecall,
  freshFarm,
  getRecall,
  inspector,
  inspectorTest,
  rawBatch,
  submitAll,
  vetlab,
} from './lib/quality.js';
import { randomUUID } from 'node:crypto';

type V = string | number | null;

/** REPORT_MAX_ROWS of the api-test profile (docker-compose.api-test.yml, P50). */
const STAND_MAX_ROWS = 13;

const DAY = 86_400_000;
const shift = (d: string, days: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const today = async () => (await dbNow()).toISOString().slice(0, 10);
const bounds = (from: string, to: string) => [`${from}T00:00:00Z`, `${shift(to, 1)}T00:00:00Z`];
const minute = (iso: string | null) => (iso === null ? null : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`);
const MINUTE = `'YYYY-MM-DD HH24:MI'`;
const ratio2 = (n: bigint, d: bigint): string => {
  const scaled = (n * 10000n * 2n + d) / (2n * d);
  return `${scaled / 100n}.${String(scaled % 100n).padStart(2, '0')}`;
};
const hours = (secs: string | null) => (secs === null ? null : Number(ratio2(BigInt(secs), 360000n)));

async function report(client: ApiClient, type: string, q: Record<string, string> = {}) {
  const res = await client.get(`/reports/${type}`, { query: q });
  await expectContract(res, 'downloadReport');
  return res;
}

interface ReadSheet {
  name: string;
  header: V[];
  headerBold: boolean;
  rows: V[][];
  formats: (string | undefined)[][];
}

async function readXlsx(bytes: Buffer): Promise<ReadSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  return wb.worksheets.map((ws) => {
    const head = ws.getRow(1);
    const width = head.cellCount;
    const header: V[] = [];
    let bold = true;
    for (let c = 1; c <= width; c++) {
      header.push(head.getCell(c).value as V);
      bold &&= head.getCell(c).font?.bold === true;
    }
    const rows: V[][] = [];
    const formats: (string | undefined)[][] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: V[] = [];
      const fmts: (string | undefined)[] = [];
      for (let c = 1; c <= width; c++) {
        const cell = row.getCell(c);
        const v = cell.value;
        cells.push(v === undefined || v === null || v === '' ? null : (v as V));
        fmts.push(cell.numFmt || undefined);
      }
      rows.push(cells);
      formats.push(fmts);
    }
    return { name: ws.name, header, headerBold: bold, rows, formats };
  });
}

/** Status 200, the xlsx media type, the contract's file name; the parsed workbook. */
async function xlsx(client: ApiClient, type: string, q: Record<string, string>, fileName: string) {
  const res = await report(client, type, { ...q, format: 'xlsx' });
  expect(res.status, res.text.slice(0, 500)).toBe(200);
  expect(res.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(res.headers.get('content-disposition')).toBe(
    `attachment; filename="${fileName}.xlsx"; filename*=UTF-8''${fileName}.xlsx`,
  );
  expect(res.headers.get('cache-control')).toBe('no-store');
  // Content-Length is optional in the contract (a streamed response has none); when sent it must be exact.
  const length = res.headers.get('content-length');
  if (length !== null) expect(Number(length)).toBe(res.bytes.length);
  return readXlsx(res.bytes);
}

async function pdf(client: ApiClient, type: string, q: Record<string, string>, fileName: string) {
  const res = await report(client, type, { ...q, format: 'pdf' });
  expect(res.status, res.text.slice(0, 500)).toBe(200);
  expect(res.contentType).toBe('application/pdf');
  expect(res.headers.get('content-disposition')).toBe(
    `attachment; filename="${fileName}.pdf"; filename*=UTF-8''${fileName}.pdf`,
  );
  expect(res.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(res.bytes.length).toBeGreaterThan(1000);
}

/** Compares once the SQL expectation is stable across the request (the scheduler keeps changing the DB). */
async function stable(
  expected: () => Promise<unknown[][]>,
  actual: () => Promise<unknown[][]>,
): Promise<void> {
  for (let i = 0; ; i++) {
    const before = await expected();
    const got = await actual();
    const after = await expected();
    if (JSON.stringify(before) === JSON.stringify(after) || i === 4) {
      expect(got).toEqual(after);
      return;
    }
  }
}

/**
 * A past UTC day (older than 2 days, so tests running now do not touch it) whose rows by `dayExpr` number 1…13 —
 * a window every backend reports in full under the stand's row limit. `extra` narrows the rows (SQL over the same
 * FROM). Prefers the fullest day.
 */
async function quietDay(
  from: string,
  dayExpr: string,
  extra = 'TRUE',
  params: unknown[] = [],
): Promise<string> {
  const rows = await query<{ day: string; n: number }>(
    `SELECT to_char(${dayExpr}, 'YYYY-MM-DD') AS day, count(*)::int AS n FROM ${from}
      WHERE ${dayExpr} < now() - interval '2 days' AND ${extra}
      GROUP BY 1 HAVING count(*) BETWEEN 1 AND ${STAND_MAX_ROWS} ORDER BY n DESC, day DESC LIMIT 1`,
    params,
  );
  if (!rows[0]) throw new Error(`no quiet day in ${from}`);
  return rows[0].day;
}

const orgOf = async (client: ApiClient): Promise<{ id: string; inn: string }> => {
  const me = await client.get('/me');
  await expectContract(me, 'getMe');
  const [o] = await query<{ inn: string }>(`SELECT inn FROM organizations WHERE id = $1`, [
    me.body.organization.id,
  ]);
  return { id: me.body.organization.id as string, inn: o!.inn };
};

describe('downloadReport: access and parameters', () => {
  it('x-report-access: roles see the whole system, headRoles only as organization heads, others 403 without params', async () => {
    // A recall whose sheets stay under the stand's row limit; the other reports over an empty past day.
    const recallId = (
      await query<{ id: string }>(
        `SELECT r.id FROM recalls r WHERE r.deleted_at IS NULL
            AND (SELECT count(*) FROM recall_batches rb WHERE rb.recall_id = r.id) <= ${STAND_MAX_ROWS}
            AND (SELECT count(*) FROM recall_tasks t WHERE t.recall_id = r.id) <= 3
          ORDER BY r.opened_at LIMIT 1`,
      )
    )[0]!.id;
    const empty = { from: '2020-01-01', to: '2020-01-01' };
    const params: Record<string, Record<string, string>> = {
      batches: empty,
      recalls: empty,
      recall: { id: recallId },
      'lab-tests': empty,
      complaints: empty,
      org: empty,
    };
    const matrix: [Role, { key?: string; head?: boolean }, string[]][] = [
      ['INSPECTOR', {}, ['batches', 'recalls', 'recall', 'lab-tests', 'complaints', 'org']],
      ['ADMIN', { head: true }, ['batches', 'recalls', 'recall', 'lab-tests', 'complaints', 'org']],
      ['FARMER', { key: 'zarya.head' }, ['batches', 'org']],
      ['FARMER', { key: 'zarya.agronom' }, []],
      ['PROCESSOR', { key: 'molkombinat.head' }, ['batches', 'org']],
      ['PROCESSOR', { key: 'molkombinat.technolog' }, []],
      ['RETAILER', { key: 'provizia.head' }, ['batches', 'org']],
      ['RETAILER', { key: 'provizia.manager' }, []],
      ['LAB', { key: 'vetlab.head' }, ['lab-tests', 'org']],
      ['LAB', { key: 'vetlab.analyst' }, []],
    ];
    const someOrg = (await orgOf(await loginAs('FARMER', { key: 'petrov' }))).id;
    for (const [role, who, ok] of matrix) {
      const client = await loginAs(role, who);
      const full = role === 'INSPECTOR' || role === 'ADMIN';
      for (const type of Object.keys(params)) {
        const q = { ...params[type], format: 'xlsx', ...(type === 'org' && full ? { id: someOrg } : {}) };
        const res = await report(client, type, q);
        if (ok.includes(type))
          expect(res.status, `${role} ${who.key ?? ''} ${type}: ${res.text.slice(0, 300)}`).toBe(200);
        else expectProblem(res, 403, 'FORBIDDEN', null);
      }
    }
    expect((await report(api(), 'batches', { format: 'xlsx' })).status).toBe(401);
  });

  it('parameters in one 400; unknown type; 404 for a missing recall or organization', async () => {
    const insp = await inspector();
    expectErrors(await report(insp, 'batches'), { format: ['validation.required'] });
    expectErrors(await report(insp, 'batches', { format: 'csv' }), { format: ['validation.enum'] });
    expectErrors(await report(insp, 'nope', { format: 'xlsx' }), { type: ['validation.enum'] });
    expectErrors(await report(insp, 'batches', { format: 'xlsx', id: randomUUID() }), {
      id: ['validation.id.notAllowed'],
    });
    expectErrors(await report(insp, 'recall', { format: 'xlsx', from: '2026-01-01', to: '2026-01-02' }), {
      from: ['validation.from.notAllowed'],
      to: ['validation.to.notAllowed'],
      id: ['validation.required'],
    });
    expectErrors(await report(insp, 'recall', { format: 'xlsx', id: 'x' }), { id: ['validation.uuid'] });
    expectErrors(await report(insp, 'org', { format: 'xlsx' }), { id: ['validation.required'] });
    expectErrors(await report(insp, 'recalls', { format: 'xlsx', from: '2026-03-02', to: '2026-03-01' }), {
      from: ['validation.range'],
    });
    expectErrors(await report(insp, 'complaints', { format: 'pdf', from: '2025-02-28', to: '2026-03-01' }), {
      from: ['validation.range.tooLong'],
    });
    expect(
      (await report(insp, 'complaints', { format: 'xlsx', from: '2019-01-02', to: '2020-01-02' })).status,
    ).toBe(200);
    const head = await loginAs('FARMER', { key: 'zarya.head' });
    expectErrors(await report(head, 'org', { format: 'xlsx', id: randomUUID() }), {
      id: ['validation.id.notAllowed'],
    });
    expectProblem(await report(insp, 'recall', { format: 'xlsx', id: randomUUID() }), 404, 'NOT_FOUND');
    expectProblem(await report(insp, 'org', { format: 'xlsx', id: randomUUID() }), 404, 'NOT_FOUND');
  });
});

describe('downloadReport: contents', () => {
  it('batches: «Партии», columns, publicCode order, cell types; a head sees origin/holder batches of its organization', async () => {
    const insp = await inspector();
    const t = await today();
    const day = await quietDay('batches', 'coalesce(harvested_at, produced_at)', 'deleted_at IS NULL');
    const [s, e] = bounds(day, day);
    const header = [
      'Код партии',
      'Продукт',
      'Категория',
      'Вид',
      'Масса, кг',
      'Статус',
      'Создатель',
      'Держатель',
      'Дата производства (UTC)',
      'Анализ требуется',
      'Основание анализа',
      'Изменена (UTC)',
    ];
    const expected = async (org: string | null) =>
      (
        await query<Record<string, V>>(
          `SELECT b.public_code, p.name AS product, p.category, b.kind, b.mass_kg::text AS mass, b.status,
                  o.name AS origin, h.name AS holder,
                  to_char(coalesce(b.harvested_at, b.produced_at), ${MINUTE}) AS at,
                  CASE WHEN b.test_required THEN 'да' ELSE 'нет' END AS req, b.test_reason,
                  to_char(b.updated_at, ${MINUTE}) AS upd
             FROM batches b JOIN products p ON p.id = b.product_id JOIN organizations o ON o.id = b.origin_org_id
             LEFT JOIN organizations h ON h.id = b.holder_org_id
            WHERE b.deleted_at IS NULL AND coalesce(b.harvested_at, b.produced_at) >= $1
              AND coalesce(b.harvested_at, b.produced_at) < $2
              AND ($3::uuid IS NULL OR b.origin_org_id = $3 OR b.holder_org_id = $3)
            ORDER BY b.public_code COLLATE "C"`,
          [s, e, org],
        )
      ).map((r) => [
        r.public_code,
        r.product,
        r.category,
        r.kind,
        Number(r.mass),
        r.status,
        r.origin,
        r.holder,
        r.at,
        r.req,
        r.test_reason,
        r.upd,
      ]);
    let sheets: ReadSheet[] = [];
    await stable(
      () => expected(null),
      async () => {
        sheets = await xlsx(insp, 'batches', { from: day, to: day }, `agrotrace-batches_${day}_${day}`);
        return sheets[0]!.rows;
      },
    );
    expect(sheets.map((x) => x.name)).toEqual(['Партии']);
    expect(sheets[0]!.header).toEqual(header);
    expect(sheets[0]!.headerBold).toBe(true);
    expect(sheets[0]!.rows.length).toBeGreaterThan(0);
    for (const [i, row] of sheets[0]!.rows.entries()) {
      expect(typeof row[4]).toBe('number');
      expect(sheets[0]!.formats[i]![4]).toBe('0.000');
      expect(row[8]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    }

    // A head: batches its organization created or holds; the default window.
    const farm = await freshFarm();
    const b1 = await rawBatch(farm, '12.345');
    const b2 = await rawBatch(farm);
    const head = await xlsx(farm.client, 'batches', {}, `agrotrace-batches_${shift(t, -29)}_${t}`);
    const card = await farm.client.get(`/batches/${b1.id}`);
    expect(head[0]!.rows.map((r) => r[0])).toEqual([b1.publicCode, b2.publicCode].sort());
    expect(head[0]!.rows.find((r) => r[0] === b1.publicCode)).toEqual([
      b1.publicCode,
      'Пшеница мягкая',
      'GRAIN',
      'RAW',
      12.345,
      'OnTest',
      card.body.origin.name,
      card.body.holder.name,
      minute(card.body.harvestedAt),
      'да',
      'NEW_FARM',
      minute(card.body.updatedAt),
    ]);
    await pdf(farm.client, 'batches', {}, `agrotrace-batches_${shift(t, -29)}_${t}`);
  });

  it('recall (FR-ANL-04): «Отзыв», «Партии», «Задачи», «Хронология»; recalls registry by openedAt', async () => {
    const insp = await inspector();
    const farm = await freshFarm();
    const processor = await freshOrg('PROCESSOR');
    const b = await rawBatch(farm);
    await submitAll(await inspectorTest(b.id), '0');
    const wb = await sentWaybill(farm.client, processor.orgId, [b]);
    expect(
      (await acceptWaybill(processor.client, wb, [{ batchId: b.id, massActualKg: b.massKg }])).status,
    ).toBe(200);
    const created = await createRecall(insp, {
      sourceBatchId: b.id,
      reason: 'Отчёт по отзыву',
      blockUpstream: true,
    });
    expect(created.status, created.text).toBe(201);
    const id = created.body.id as string;
    const task = created.body.tasks[0];
    expect((await confirmTask(processor.client, task.id, task.version)).status).toBe(200);
    const r = (await getRecall(insp, id)).body;
    expect(r.status).toBe('CLOSED');
    const [secs] = await query<{ s: string }>(
      `SELECT floor(extract(epoch FROM t.confirmed_at - r.opened_at))::bigint::text AS s
         FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id WHERE t.id = $1`,
      [task.id],
    );
    const sheets = await xlsx(insp, 'recall', { id }, `agrotrace-recall_${id}`);
    expect(sheets.map((x) => x.name)).toEqual(['Отзыв', 'Партии', 'Задачи', 'Хронология']);
    expect(sheets.every((x) => x.headerBold)).toBe(true);
    const [summary, batches, tasks, chrono] = sheets as [ReadSheet, ReadSheet, ReadSheet, ReadSheet];
    expect(summary.header).toEqual(['Поле', 'Значение']);
    expect(summary.rows).toEqual([
      ['ID', id],
      ['Исходная партия', b.publicCode],
      ['Продукт', 'Пшеница мягкая'],
      ['Источник', 'INSPECTOR'],
      ['Причина', 'Отчёт по отзыву'],
      ['Статус', 'CLOSED'],
      ['Блокировка источников', 'да'],
      ['Открыт (UTC)', minute(r.openedAt)],
      ['Закрыт (UTC)', minute(r.closedAt)],
      ['Инициатор', r.openedBy.fullName],
      ['Партий', r.batchesCount],
      ['Задач', 1],
      ['Подтверждено', 1],
    ]);
    expect(batches.header).toEqual([
      'Код партии',
      'Продукт',
      'Направление',
      'Глубина',
      'Статус до отзыва',
      'Статус сейчас',
      'Держатель',
    ]);
    expect(batches.rows).toEqual(
      r.batches.map(
        (m: {
          batch: { publicCode: string; product: { name: string }; status: string; holder: { name: string } };
          direction: string;
          depth: number;
          statusBefore: string;
        }) => [
          m.batch.publicCode,
          m.batch.product.name,
          m.direction,
          m.depth,
          m.statusBefore,
          m.batch.status,
          m.batch.holder.name,
        ],
      ),
    );
    expect(batches.rows[0]!.slice(2, 6)).toEqual(['SOURCE', 0, 'Accepted', 'WrittenOff']);
    const tk = r.tasks[0];
    expect(tasks.rows).toEqual([
      [
        b.publicCode,
        tk.holder.name,
        minute(tk.dueAt),
        'CONFIRMED',
        null,
        minute(tk.confirmedAt),
        tk.confirmedBy.fullName,
        hours(secs!.s),
      ],
    ]);
    expect(tasks.formats[0]![7]).toBe('0.00');
    expect(chrono.header).toEqual(['Время (UTC)', 'Событие', 'Партия', 'Организация']);
    expect(chrono.rows).toEqual([
      [minute(r.openedAt), 'RECALL_OPENED', b.publicCode, r.sourceBatch.origin.name],
      [minute(r.openedAt), 'TASK_CREATED', b.publicCode, tk.holder.name],
      [minute(tk.confirmedAt), 'TASK_CONFIRMED', b.publicCode, tk.holder.name],
      [minute(r.closedAt), 'RECALL_CLOSED', b.publicCode, r.sourceBatch.origin.name],
    ]);
    await pdf(insp, 'recall', { id }, `agrotrace-recall_${id}`);

    // The registry: every non-deleted recall opened in the window, by openedAt then id (a past day under the limit).
    const day = await quietDay('recalls', 'opened_at', 'deleted_at IS NULL');
    const [s, e] = bounds(day, day);
    const expected = async () =>
      (
        await query<Record<string, V>>(
          `SELECT r.id, b.public_code, p.name, r.trigger, r.reason, r.status, to_char(r.opened_at, ${MINUTE}) AS o,
                  to_char(r.closed_at, ${MINUTE}) AS c,
                  floor(extract(epoch FROM r.closed_at - r.opened_at))::bigint::text AS secs,
                  (SELECT count(*)::int FROM recall_batches rb WHERE rb.recall_id = r.id) AS nb,
                  (SELECT count(*)::int FROM recall_tasks x WHERE x.recall_id = r.id) AS nt,
                  (SELECT count(*)::int FROM recall_tasks x WHERE x.recall_id = r.id AND x.status = 'CONFIRMED') AS nc,
                  (SELECT count(*)::int FROM recall_tasks x
                    WHERE x.recall_id = r.id AND x.status <> 'CONFIRMED' AND now() > x.due_at) AS no
             FROM recalls r JOIN batches b ON b.id = r.source_batch_id JOIN products p ON p.id = b.product_id
            WHERE r.deleted_at IS NULL AND r.opened_at >= $1 AND r.opened_at < $2
            ORDER BY r.opened_at, r.id::text COLLATE "C"`,
          [s, e],
        )
      ).map((x) => [
        x.id,
        x.public_code,
        x.name,
        x.trigger,
        x.reason,
        x.status,
        x.o,
        x.c,
        hours(x.secs as string | null),
        x.nb,
        x.nt,
        x.nc,
        x.no,
      ]);
    let reg: ReadSheet[] = [];
    await stable(expected, async () => {
      reg = await xlsx(insp, 'recalls', { from: day, to: day }, `agrotrace-recalls_${day}_${day}`);
      return reg[0]!.rows;
    });
    expect(reg[0]!.name).toBe('Отзывы');
    expect(reg[0]!.header).toEqual([
      'ID отзыва',
      'Исходная партия',
      'Продукт',
      'Источник',
      'Причина',
      'Статус',
      'Открыт (UTC)',
      'Закрыт (UTC)',
      'Длительность, ч',
      'Партий',
      'Задач',
      'Подтверждено',
      'Просрочено',
    ]);
    expect(reg[0]!.rows.length).toBeGreaterThan(0);
    await pdf(insp, 'recalls', { from: day, to: day }, `agrotrace-recalls_${day}_${day}`);
  });

  it('lab-tests (all / a lab head: own laboratory) with exceeded indicators; complaints without the buyer contact', async () => {
    const lab = await vetlab();
    const expected = async (labOrg: string | null, day: string) => {
      const [s, e] = bounds(day, day);
      return (
        await query<Record<string, V>>(
          `SELECT b.public_code, p.name AS product, l.name AS lab, lt.reason, lt.status, lt.conclusion,
                  to_char(lt.created_at, ${MINUTE}) AS c, to_char(lt.due_at, ${MINUTE}) AS d,
                  to_char(lt.sampled_at, ${MINUTE}) AS sa, to_char(lt.completed_at, ${MINUTE}) AS co,
                  CASE WHEN lt.status IN ('QUEUED', 'SAMPLED', 'ESCALATED') AND now() > lt.due_at THEN 'да' ELSE 'нет' END AS od,
                  (SELECT string_agg(i.name, ', ' ORDER BY i.name COLLATE "C") FROM lab_results lr
                     JOIN indicators i ON i.id = lr.indicator_id WHERE lr.lab_test_id = lt.id AND lr.is_exceeded) AS ex
             FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id JOIN products p ON p.id = b.product_id
             JOIN organizations l ON l.id = lt.lab_org_id
            WHERE lt.deleted_at IS NULL AND b.deleted_at IS NULL AND lt.created_at >= $1 AND lt.created_at < $2
              AND ($3::uuid IS NULL OR lt.lab_org_id = $3)
            ORDER BY lt.created_at, lt.id::text COLLATE "C"`,
          [s, e, labOrg],
        )
      ).map((x) => Object.values(x));
    };
    // All laboratories: a past day under the limit with a FAIL whose exceeded indicators are listed.
    const [withFail] = await query<{ day: string }>(
      `SELECT to_char(lt.created_at, 'YYYY-MM-DD') AS day FROM lab_tests lt
        WHERE lt.created_at < now() - interval '2 days' AND lt.deleted_at IS NULL
        GROUP BY 1
       HAVING count(*) <= ${STAND_MAX_ROWS}
          AND bool_or(lt.conclusion = 'FAIL' AND EXISTS (SELECT 1 FROM lab_results lr
                                                          WHERE lr.lab_test_id = lt.id AND lr.is_exceeded))
        ORDER BY 1 DESC LIMIT 1`,
    );
    // The seed has one (a FAIL with exceeded indicators alone on its day); without it the check must not pass silently.
    expect(withFail, 'a past day under the row limit with a FAIL that has exceeded indicators').toBeDefined();
    const day = withFail!.day;
    let all: ReadSheet[] = [];
    await stable(
      () => expected(null, day),
      async () => {
        all = await xlsx(
          await inspector(),
          'lab-tests',
          { from: day, to: day },
          `agrotrace-lab-tests_${day}_${day}`,
        );
        return all[0]!.rows;
      },
    );
    expect(all[0]!.name).toBe('Анализы');
    expect(all[0]!.header).toEqual([
      'Код партии',
      'Продукт',
      'Лаборатория',
      'Основание',
      'Статус',
      'Заключение',
      'Создан (UTC)',
      'Срок (UTC)',
      'Проба (UTC)',
      'Завершён (UTC)',
      'Просрочен',
      'Превышенные показатели',
    ]);
    expect(all[0]!.rows.some((x) => x[5] === 'FAIL' && typeof x[11] === 'string')).toBe(true);
    // A laboratory head: its own tests only.
    const own = await quietDay('lab_tests', 'created_at', 'deleted_at IS NULL AND lab_org_id = $1', [
      lab.orgId,
    ]);
    await stable(
      () => expected(lab.orgId, own),
      async () =>
        (await xlsx(lab.client, 'lab-tests', { from: own, to: own }, `agrotrace-lab-tests_${own}_${own}`))[0]!
          .rows,
    );
    await pdf(lab.client, 'lab-tests', { from: own, to: own }, `agrotrace-lab-tests_${own}_${own}`);

    const insp = await inspector();
    const cday = await quietDay('complaints', 'created_at', 'deleted_at IS NULL');
    const [s, e] = bounds(cday, cday);
    const expectedComplaints = async () =>
      (
        await query<Record<string, V>>(
          `SELECT to_char(c.created_at, ${MINUTE}) AS c, b.public_code, p.name, c.text, c.status, c.decision,
                  c.decision_comment, u.full_name, to_char(c.decided_at, ${MINUTE}) AS d
             FROM complaints c JOIN batches b ON b.id = c.batch_id JOIN products p ON p.id = b.product_id
             LEFT JOIN users u ON u.id = c.inspector_id
            WHERE c.deleted_at IS NULL AND c.created_at >= $1 AND c.created_at < $2
            ORDER BY c.created_at, c.id::text COLLATE "C"`,
          [s, e],
        )
      ).map((x) => Object.values(x));
    let comp: ReadSheet[] = [];
    await stable(expectedComplaints, async () => {
      comp = await xlsx(insp, 'complaints', { from: cday, to: cday }, `agrotrace-complaints_${cday}_${cday}`);
      return comp[0]!.rows;
    });
    expect(comp[0]!.name).toBe('Жалобы');
    expect(comp[0]!.header).toEqual([
      'Поступила (UTC)',
      'Код партии',
      'Продукт',
      'Текст',
      'Статус',
      'Решение',
      'Комментарий',
      'Инспектор',
      'Решение принято (UTC)',
    ]);
    expect(comp[0]!.rows.length).toBeGreaterThan(0);
    await pdf(insp, 'complaints', { from: cday, to: cday }, `agrotrace-complaints_${cday}_${cday}`);
  });

  it('org: «Организация», «Партии по статусам», «Анализы», «Задачи отзыва»; a head without id gets its own', async () => {
    const insp = await inspector();
    const t = await today();
    const from = shift(t, -29);
    const farm = await freshFarm();
    const b = await rawBatch(farm);
    const test = await inspectorTest(b.id);
    await submitAll(test, '0');
    const b2 = await rawBatch(farm);
    const rec = await createRecall(insp, { sourceBatchId: b2.id, reason: 'Сводка', blockUpstream: false });
    expect(rec.status, rec.text).toBe(201);
    const { inn } = await orgOf(farm.client);
    const [o] = await query<{ name: string; region: string; rating: number }>(
      `SELECT o.name, r.name AS region, o.trust_rating AS rating FROM organizations o JOIN regions r ON r.id = o.region_id
        WHERE o.id = $1`,
      [farm.orgId],
    );
    const file = `agrotrace-org_${inn}_${from}_${t}`;
    const sheets = await xlsx(insp, 'org', { id: farm.orgId }, file);
    expect(sheets.map((x) => x.name)).toEqual([
      'Организация',
      'Партии по статусам',
      'Анализы',
      'Задачи отзыва',
    ]);
    const [info, statuses, tests, tasks] = sheets as [ReadSheet, ReadSheet, ReadSheet, ReadSheet];
    expect(info.rows).toEqual([
      ['Название', o!.name],
      ['ИНН', inn],
      ['Тип', 'FARM'],
      ['Регион', o!.region],
      ['Статус', 'ACTIVE'],
      ['Рейтинг доверия', o!.rating],
      ['Период', `${from} — ${t}`],
    ]);
    expect(statuses.header).toEqual(['Статус', 'Количество']);
    expect(statuses.rows.map((r) => r[0])).toEqual([
      'Created',
      'OnTest',
      'Approved',
      'InTransit',
      'Accepted',
      'Processed',
      'OnSale',
      'Sold',
      'Blocked',
      'Recalled',
      'WrittenOff',
    ]);
    expect(Object.fromEntries(statuses.rows.filter((r) => r[1] !== 0))).toEqual({ Approved: 1, Recalled: 1 });
    expect(statuses.formats.every((f) => f[1] === '0')).toBe(true);
    const card = await (await vetlab()).client.get(`/lab-tests/${test.id}`);
    expect(tests.header).toEqual(['Код партии', 'Продукт', 'Лаборатория', 'Заключение', 'Завершён (UTC)']);
    expect(tests.rows).toEqual([
      [b.publicCode, 'Пшеница мягкая', card.body.lab.name, 'PASS', minute(card.body.completedAt)],
    ]);
    const task = rec.body.tasks[0];
    expect(tasks.header).toEqual(['Код партии', 'ID отзыва', 'Срок (UTC)', 'Статус', 'Подтверждена (UTC)']);
    expect(tasks.rows).toEqual([[b2.publicCode, rec.body.id, minute(task.dueAt), 'OPEN', null]]);
    // The head: no id (or its own id) — the same report of its organization.
    const own = await xlsx(farm.client, 'org', {}, file);
    expect(own[0]!.rows).toEqual(info.rows);
    expect((await xlsx(farm.client, 'org', { id: farm.orgId }, file))[1]!.rows).toEqual(statuses.rows);
    await pdf(farm.client, 'org', {}, file);
    // A laboratory: «Анализы» are the tests it performed (a past day under the limit).
    const lab = await vetlab();
    const labOrg = await orgOf(lab.client);
    const day = await quietDay(
      'lab_tests',
      'completed_at',
      "deleted_at IS NULL AND status = 'DONE' AND lab_org_id = $1",
      [lab.orgId],
    );
    const [ls, le] = bounds(day, day);
    const labSheets = await xlsx(
      lab.client,
      'org',
      { from: day, to: day },
      `agrotrace-org_${labOrg.inn}_${day}_${day}`,
    );
    expect(labSheets[0]!.rows[5]).toEqual(['Рейтинг доверия', null]);
    const done = await query<{ code: string }>(
      `SELECT b.public_code AS code FROM lab_tests lt JOIN batches b ON b.id = lt.batch_id
        WHERE lt.lab_org_id = $1 AND lt.status = 'DONE' AND lt.deleted_at IS NULL AND b.deleted_at IS NULL
          AND lt.completed_at >= $2 AND lt.completed_at < $3 ORDER BY lt.completed_at, lt.id::text COLLATE "C"`,
      [lab.orgId, ls, le],
    );
    expect(labSheets[2]!.rows.map((r) => r[0])).toEqual(done.map((d) => d.code));
  });
});

describe('downloadReport: the row limit (REPORT_MAX_ROWS, P50)', () => {
  it('13 rows in a sheet → 200, 14 → 400 validation.report.tooManyRows — the first sheet and a later one', async () => {
    const t = await today();
    const win = `${shift(t, -29)}_${t}`;
    const farm = await freshFarm();
    for (let i = 0; i < STAND_MAX_ROWS; i++) await rawBatch(farm);
    const full = await xlsx(farm.client, 'batches', {}, `agrotrace-batches_${win}`);
    expect(full[0]!.rows).toHaveLength(STAND_MAX_ROWS);
    await rawBatch(farm);
    for (const format of ['xlsx', 'pdf'])
      expectErrors(await report(farm.client, 'batches', { format }), {
        type: ['validation.report.tooManyRows'],
      });

    // «Анализы», the third sheet of the org report: DONE tests of the farm's batches.
    const farm2 = await freshFarm();
    const b = await rawBatch(farm2);
    for (let i = 0; i < STAND_MAX_ROWS; i++) await submitAll(await inspectorTest(b.id), '0');
    const { inn } = await orgOf(farm2.client);
    const org = await xlsx(farm2.client, 'org', {}, `agrotrace-org_${inn}_${win}`);
    expect(org[2]!.rows).toHaveLength(STAND_MAX_ROWS);
    await submitAll(await inspectorTest(b.id), '0');
    expectErrors(await report(farm2.client, 'org', { format: 'xlsx' }), {
      type: ['validation.report.tooManyRows'],
    });
  });
});

describe('analytics: soft-deleted batches', () => {
  it('their lab tests and recall tasks count nowhere (dashboard org, report org)', async () => {
    const t = await today();
    const farm = await freshFarm();
    const b1 = await rawBatch(farm);
    await submitAll(await inspectorTest(b1.id), '0');
    const b2 = await rawBatch(farm);
    const rec = await createRecall(await inspector(), {
      sourceBatchId: b2.id,
      reason: 'Удалённые',
      blockUpstream: false,
    });
    expect(rec.status, rec.text).toBe(201);
    // Documented fixture write (precedent of Task 10): no operation deletes a batch.
    await fixtureWrite(`UPDATE batches SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [[b1.id, b2.id]]);
    const dash = await farm.client.get('/analytics/dashboard', { query: { scope: 'org' } });
    await expectContract(dash, 'getDashboard');
    expect(dash.body.labResults).toEqual({ pass: 0, fail: 0 });
    expect(dash.body.openTasks).toBe(0);
    expect(dash.body.byStatus.every((s: { count: number }) => s.count === 0)).toBe(true);
    const { inn } = await orgOf(farm.client);
    const sheets = await xlsx(farm.client, 'org', {}, `agrotrace-org_${inn}_${shift(t, -29)}_${t}`);
    expect(sheets[2]!.rows).toEqual([]);
    expect(sheets[3]!.rows).toEqual([]);
    expect(
      (await xlsx(farm.client, 'batches', {}, `agrotrace-batches_${shift(t, -29)}_${t}`))[0]!.rows,
    ).toEqual([]);
  });
});
