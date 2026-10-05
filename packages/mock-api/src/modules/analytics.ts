import { canEntityTransition } from '../domain/transitions.js';
import { compareCodePoints, isOverdue, ratioPercent2 } from '@agrotrace/domain';
import { json, type Ctx, type Handler } from '../http/context.js';
import { inDateRange, type QueryReader } from '../http/params.js';
import { ApiError, notFound } from '../http/problem.js';
import { loadFonts } from '../render/documents.js';
import { A4_LANDSCAPE, PdfDocument } from '../render/pdf.js';
import { writeXlsx, type XCell, type XSheet } from '../lib/xlsx.js';
import { DAY_MS, iso } from '../lib/time.js';
import type { Mock } from '../runtime.js';
import type { BatchStatus, LabTestRow, Principal, RecallTaskRow } from '../store/types.js';
import { orgRef } from '../views/refs.js';
import { LAB_OPEN } from '../domain/production.js';
import { recallView } from './recalls.js';

const STATUSES: BatchStatus[] = ['Created', 'OnTest', 'Approved', 'InTransit', 'Accepted', 'Processed', 'OnSale', 'Sold', 'Blocked', 'Recalled', 'WrittenOff'];

function hours(durationsMs: number[]): string | null {
  if (durationsMs.length === 0) return null;
  const s = durationsMs.reduce((sum, d) => sum + BigInt(Math.floor(d / 1000)), 0n);
  return ratioPercent2(s, BigInt(durationsMs.length) * 360_000n);
}

function windowOf(m: Mock, q: QueryReader): { from: string; to: string } {
  const range = q.dateRange();
  q.done();
  const today = iso(m.store.now()).slice(0, 10);
  const shift = (d: string, days: number) => iso(Date.parse(`${d}T00:00:00Z`) + days * DAY_MS).slice(0, 10);
  let from = range.from;
  let to = range.to;
  if (!from && !to) to = today;
  if (to && !from) from = shift(to, -29);
  if (from && !to) to = shift(from, 29);
  if ((Date.parse(to!) - Date.parse(from!)) / DAY_MS + 1 > 366) throw new ApiError(400, 'VALIDATION', { errors: { from: ['validation.range.tooLong'] } });
  return { from: from!, to: to! };
}

const doneIn = (t: LabTestRow, w: { from: string; to: string }): boolean =>
  t.deleted_at === null && t.status === 'DONE' && inDateRange(w, t.completed_at);

function shares(m: Mock, tests: LabTestRow[], keyOf: (t: LabTestRow) => { key: string; name: string } | null) {
  const acc = new Map<string, { key: string; name: string; tested: number; failed: number }>();
  for (const t of tests) {
    const k = keyOf(t);
    if (!k) continue;
    const e = acc.get(k.key) ?? { ...k, tested: 0, failed: 0 };
    e.tested += 1;
    if (t.conclusion === 'FAIL') e.failed += 1;
    acc.set(k.key, e);
  }
  return [...acc.values()]
    .map((e) => ({ ...e, share: ratioPercent2(BigInt(e.failed), BigInt(e.tested)) }))
    .sort((a, b) => b.failed * a.tested - a.failed * b.tested || b.tested - a.tested || compareCodePoints(a.name, b.name))
    .slice(0, 10);
}

function dashboard(ctx: Ctx, p: Principal, scope: string, w: { from: string; to: string }) {
  const s = ctx.store;
  const now = s.nowIso();
  if (scope === 'inspector') {
    const tests = s.t.lab_tests.filter((t) => doneIn(t, w) && s.must('batches', t.batch_id).deleted_at === null);
    const batchOf = (t: LabTestRow) => s.must('batches', t.batch_id);
    return {
      scope,
      period: w,
      batchesTotal: s.t.batches.filter((b) => b.deleted_at === null && inDateRange(w, b.created_at)).length,
      rejectedShare: {
        byProduct: shares(ctx, tests, (t) => {
          const pr = s.must('products', batchOf(t).product_id);
          return { key: pr.id, name: pr.name };
        }),
        byFarm: shares(ctx, tests, (t) => {
          const b = batchOf(t);
          const o = s.must('organizations', b.origin_org_id);
          return b.kind === 'RAW' && o.type === 'FARM' ? { key: o.id, name: o.name } : null;
        }),
      },
      activeRecalls: s.t.recalls.filter((r) => r.deleted_at === null && r.status === 'OPEN').length,
      avgRecallHours: hours(
        s.t.recalls
          .filter((r) => r.deleted_at === null && r.closed_at && inDateRange(w, r.closed_at))
          .map((r) => Date.parse(r.closed_at!) - Date.parse(r.opened_at)),
      ),
      violationsByRegion: [...s.t.regions]
        .sort((a, b) => compareCodePoints(a.code, b.code))
        .map((r) => ({
          code: r.code,
          name: r.name,
          count: tests.filter((t) => t.conclusion === 'FAIL' && s.must('organizations', batchOf(t).origin_org_id).region_id === r.id).length,
        })),
    };
  }
  if (scope === 'org') {
    const held = s.t.batches.filter((b) => b.deleted_at === null && b.holder_org_id === p.orgId);
    const tests = s.t.lab_tests.filter((t) => doneIn(t, w) && s.must('batches', t.batch_id).origin_org_id === p.orgId && s.must('batches', t.batch_id).deleted_at === null);
    const tasks = s.t.recall_tasks.filter((t) => t.holder_org_id === p.orgId && canEntityTransition('recallTask', t.status, 'CONFIRMED') && s.must('batches', t.batch_id).deleted_at === null);
    return {
      scope,
      period: w,
      organization: orgRef(ctx, p.orgId),
      byStatus: STATUSES.map((status) => ({ status, count: held.filter((b) => b.status === status).length })),
      labResults: { pass: tests.filter((t) => t.conclusion === 'PASS').length, fail: tests.filter((t) => t.conclusion === 'FAIL').length },
      openTasks: tasks.length,
      overdueTasks: tasks.filter((t) => isOverdue({ dueAt: t.due_at, now }).overdue).length,
    };
  }
  const own = s.t.lab_tests.filter((t) => t.deleted_at === null && t.lab_org_id === p.orgId && s.must('batches', t.batch_id).deleted_at === null);
  const queue = own.filter((t) => LAB_OPEN.has(t.status));
  const completed = own.filter((t) => doneIn(t, w));
  return {
    scope,
    period: w,
    organization: orgRef(ctx, p.orgId),
    queue: queue.length,
    overdue: queue.filter((t) => isOverdue({ dueAt: t.due_at, now }).overdue).length,
    completed: completed.length,
    failed: completed.filter((t) => t.conclusion === 'FAIL').length,
    avgHours: hours(completed.map((t) => Date.parse(t.completed_at!) - Date.parse(t.created_at))),
  };
}

const minute = (t: string | null | undefined): string | null => (t ? `${t.slice(0, 10)} ${t.slice(11, 16)}` : null);
const T = (v: string | null | undefined): XCell => ({ t: 'text', v: v ?? null });
const N = (v: number | null): XCell => ({ t: 'int', v });
const M = (v: string | null): XCell => ({ t: 'mass', v });
const D2 = (v: string | null): XCell => ({ t: 'dec2', v });
const yes = (b: boolean): XCell => T(b ? 'да' : 'нет');

interface Report {
  title: string;
  fileName: string;
  periodLine: string;
  sheets: XSheet[];
}

function buildReport(ctx: Ctx, p: Principal, type: string, w: { from: string; to: string } | null, id: string | null, head: boolean): Report {
  const s = ctx.store;
  const name = (orgId: string) => s.must('organizations', orgId).name;
  const product = (pid: string) => s.must('products', pid).name;
  const code = (bid: string) => s.must('batches', bid).public_code;
  const range = w ?? { from: '', to: '' };
  const period = w ? `Период: ${w.from} — ${w.to} (UTC)` : `Отзыв: ${id}`;
  const file = (base: string, ext = '') => `${base}${ext}`;
  switch (type) {
    case 'batches': {
      const rows = s.t.batches
        .filter((b) => b.deleted_at === null && (!head || b.origin_org_id === p.orgId || b.holder_org_id === p.orgId))
        .filter((b) => inDateRange(range, b.kind === 'RAW' ? b.harvested_at : b.produced_at))
        .sort((a, b) => compareCodePoints(a.public_code, b.public_code));
      return {
        title: 'Реестр партий',
        fileName: file(`agrotrace-batches_${range.from}_${range.to}`),
        periodLine: period,
        sheets: [
          {
            name: 'Партии',
            header: ['Код партии', 'Продукт', 'Категория', 'Вид', 'Масса, кг', 'Статус', 'Создатель', 'Держатель', 'Дата производства (UTC)', 'Анализ требуется', 'Основание анализа', 'Изменена (UTC)'],
            rows: rows.map((b) => [
              T(b.public_code),
              T(product(b.product_id)),
              T(s.must('products', b.product_id).category),
              T(b.kind),
              M(b.mass_kg),
              T(b.status),
              T(name(b.origin_org_id)),
              T(name(b.holder_org_id)),
              T(minute(b.harvested_at ?? b.produced_at)),
              yes(b.test_required),
              T(b.test_reason),
              T(minute(b.updated_at)),
            ]),
          },
        ],
      };
    }
    case 'recalls': {
      const rows = s.t.recalls
        .filter((r) => r.deleted_at === null && inDateRange(range, r.opened_at))
        .sort((a, b) => Date.parse(a.opened_at) - Date.parse(b.opened_at) || compareCodePoints(a.id, b.id));
      return {
        title: 'Реестр отзывов',
        fileName: file(`agrotrace-recalls_${range.from}_${range.to}`),
        periodLine: period,
        sheets: [
          {
            name: 'Отзывы',
            header: ['ID отзыва', 'Исходная партия', 'Продукт', 'Источник', 'Причина', 'Статус', 'Открыт (UTC)', 'Закрыт (UTC)', 'Длительность, ч', 'Партий', 'Задач', 'Подтверждено', 'Просрочено'],
            rows: rows.map((r) => {
              const v = recallView(ctx, r);
              return [
                T(r.id),
                T(code(r.source_batch_id)),
                T(product(s.must('batches', r.source_batch_id).product_id)),
                T(r.trigger),
                T(r.reason),
                T(r.status),
                T(minute(r.opened_at)),
                T(minute(r.closed_at)),
                D2(r.closed_at ? hours([Date.parse(r.closed_at) - Date.parse(r.opened_at)]) : null),
                N(v.batchesCount),
                N(v.progress.total),
                N(v.progress.confirmed),
                N(v.progress.overdue),
              ];
            }),
          },
        ],
      };
    }
    case 'recall': {
      const r = s.get('recalls', id!);
      if (!r || r.deleted_at !== null) throw notFound();
      const v = recallView(ctx, r);
      const opener = r.created_by ? s.get('users', r.created_by)?.full_name ?? null : null;
      const events: { at: string; order: number; event: string; code: string; org: string }[] = [
        { at: r.opened_at, order: 0, event: 'RECALL_OPENED', code: code(r.source_batch_id), org: name(s.must('batches', r.source_batch_id).origin_org_id) },
      ];
      const tasks = s.t.recall_tasks.filter((t) => t.recall_id === r.id);
      for (const t of tasks) {
        events.push({ at: r.opened_at, order: 1, event: 'TASK_CREATED', code: code(t.batch_id), org: name(t.holder_org_id) });
        if (t.escalated_at) events.push({ at: t.escalated_at, order: 2, event: 'TASK_OVERDUE', code: code(t.batch_id), org: name(t.holder_org_id) });
        if (t.confirmed_at) events.push({ at: t.confirmed_at, order: 3, event: 'TASK_CONFIRMED', code: code(t.batch_id), org: name(t.holder_org_id) });
      }
      if (r.closed_at) events.push({ at: r.closed_at, order: 4, event: 'RECALL_CLOSED', code: code(r.source_batch_id), org: name(s.must('batches', r.source_batch_id).origin_org_id) });
      events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order || compareCodePoints(a.code, b.code));
      const taskOf = (x: { id: string }): RecallTaskRow => s.must('recall_tasks', x.id);
      return {
        title: 'Отчёт по отзыву',
        fileName: `agrotrace-recall_${r.id}`,
        periodLine: period,
        sheets: [
          {
            name: 'Отзыв',
            header: ['Поле', 'Значение'],
            rows: [
              ['ID', r.id],
              ['Исходная партия', code(r.source_batch_id)],
              ['Продукт', product(s.must('batches', r.source_batch_id).product_id)],
              ['Источник', r.trigger],
              ['Причина', r.reason],
              ['Статус', r.status],
              ['Блокировка источников', r.block_upstream ? 'да' : 'нет'],
              ['Открыт (UTC)', minute(r.opened_at)],
              ['Закрыт (UTC)', minute(r.closed_at)],
              ['Инициатор', opener],
              ['Партий', String(v.batchesCount)],
              ['Задач', String(v.progress.total)],
              ['Подтверждено', String(v.progress.confirmed)],
            ].map(([k, val]) => [T(k), T(val)]),
          },
          {
            name: 'Партии',
            header: ['Код партии', 'Продукт', 'Направление', 'Глубина', 'Статус до отзыва', 'Статус сейчас', 'Держатель'],
            rows: v.batches.map((b) => [T(b.batch.publicCode), T(b.batch.product.name), T(b.direction), N(b.depth), T(b.statusBefore), T(b.batch.status), T(b.batch.holder.name)]),
          },
          {
            name: 'Задачи',
            header: ['Код партии', 'Держатель', 'Срок (UTC)', 'Статус', 'Эскалирована (UTC)', 'Подтверждена (UTC)', 'Подтвердил', 'Время подтверждения, ч'],
            rows: v.tasks.map((t) => {
              const row = taskOf(t);
              return [
                T(t.batch.publicCode),
                T(t.holder.name),
                T(minute(t.dueAt)),
                T(t.status),
                T(minute(t.escalatedAt)),
                T(minute(t.confirmedAt)),
                T(t.confirmedBy?.fullName ?? null),
                D2(row.confirmed_at ? hours([Date.parse(row.confirmed_at) - Date.parse(r.opened_at)]) : null),
              ];
            }),
          },
          {
            name: 'Хронология',
            header: ['Время (UTC)', 'Событие', 'Партия', 'Организация'],
            rows: events.map((e) => [T(minute(e.at)), T(e.event), T(e.code), T(e.org)]),
          },
        ],
      };
    }
    case 'lab-tests': {
      const rows = s.t.lab_tests
        .filter((t) => t.deleted_at === null && (!head || t.lab_org_id === p.orgId) && inDateRange(range, t.created_at))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || compareCodePoints(a.id, b.id));
      const now = s.nowIso();
      return {
        title: 'Лабораторные анализы',
        fileName: file(`agrotrace-lab-tests_${range.from}_${range.to}`),
        periodLine: period,
        sheets: [
          {
            name: 'Анализы',
            header: ['Код партии', 'Продукт', 'Лаборатория', 'Основание', 'Статус', 'Заключение', 'Создан (UTC)', 'Срок (UTC)', 'Проба (UTC)', 'Завершён (UTC)', 'Просрочен', 'Превышенные показатели'],
            rows: rows.map((t) => [
              T(code(t.batch_id)),
              T(product(s.must('batches', t.batch_id).product_id)),
              T(name(t.lab_org_id)),
              T(t.reason),
              T(t.status),
              T(t.conclusion),
              T(minute(t.created_at)),
              T(minute(t.due_at)),
              T(minute(t.sampled_at)),
              T(minute(t.completed_at)),
              yes(LAB_OPEN.has(t.status) && isOverdue({ dueAt: t.due_at, now }).overdue),
              T(
                s.t.lab_results
                  .filter((x) => x.lab_test_id === t.id && x.is_exceeded)
                  .map((x) => s.must('indicators', x.indicator_id).name)
                  .sort(compareCodePoints)
                  .join(', ') || null,
              ),
            ]),
          },
        ],
      };
    }
    case 'complaints': {
      const rows = s.t.complaints
        .filter((c) => c.deleted_at === null && inDateRange(range, c.created_at))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || compareCodePoints(a.id, b.id));
      return {
        title: 'Жалобы',
        fileName: file(`agrotrace-complaints_${range.from}_${range.to}`),
        periodLine: period,
        sheets: [
          {
            name: 'Жалобы',
            header: ['Поступила (UTC)', 'Код партии', 'Продукт', 'Текст', 'Статус', 'Решение', 'Комментарий', 'Инспектор', 'Решение принято (UTC)'],
            rows: rows.map((c) => [
              T(minute(c.created_at)),
              T(code(c.batch_id)),
              T(product(s.must('batches', c.batch_id).product_id)),
              T(c.text),
              T(c.status),
              T(c.decision),
              T(c.decision_comment),
              T(c.inspector_id ? s.get('users', c.inspector_id)?.full_name ?? null : null),
              T(minute(c.decided_at)),
            ]),
          },
        ],
      };
    }
    default: {
      const org = s.get('organizations', id!);
      if (!org || org.deleted_at !== null) throw notFound();
      const isLab = org.type === 'LAB';
      const tests = s.t.lab_tests
        .filter((t) => t.deleted_at === null && t.status === 'DONE' && inDateRange(range, t.completed_at))
        .filter((t) => (isLab ? t.lab_org_id === org.id : s.must('batches', t.batch_id).origin_org_id === org.id))
        .sort((a, b) => Date.parse(a.completed_at!) - Date.parse(b.completed_at!) || compareCodePoints(a.id, b.id));
      const tasks = s.t.recall_tasks
        .filter((t) => t.holder_org_id === org.id && inDateRange(range, t.created_at))
        .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at) || compareCodePoints(a.id, b.id));
      const held = s.t.batches.filter((b) => b.deleted_at === null && b.holder_org_id === org.id);
      const reg = s.must('regions', org.region_id);
      return {
        title: 'Сводка по организации',
        fileName: file(`agrotrace-org_${org.inn}_${range.from}_${range.to}`),
        periodLine: period,
        sheets: [
          {
            name: 'Организация',
            header: ['Поле', 'Значение'],
            rows: [
              ['Название', org.name],
              ['ИНН', org.inn],
              ['Тип', org.type],
              ['Регион', reg.name],
              ['Статус', org.status],
              ['Рейтинг доверия', org.type === 'FARM' && org.trust_rating !== null ? String(org.trust_rating) : null],
              ['Период', `${range.from} — ${range.to}`],
            ].map(([k, v]) => [T(k), T(v)]),
          },
          { name: 'Партии по статусам', header: ['Статус', 'Количество'], rows: STATUSES.map((st) => [T(st), N(held.filter((b) => b.status === st).length)]) },
          {
            name: 'Анализы',
            header: ['Код партии', 'Продукт', 'Лаборатория', 'Заключение', 'Завершён (UTC)'],
            rows: tests.map((t) => [T(code(t.batch_id)), T(product(s.must('batches', t.batch_id).product_id)), T(name(t.lab_org_id)), T(t.conclusion), T(minute(t.completed_at))]),
          },
          {
            name: 'Задачи отзыва',
            header: ['Код партии', 'ID отзыва', 'Срок (UTC)', 'Статус', 'Подтверждена (UTC)'],
            rows: tasks.map((t) => [T(code(t.batch_id)), T(t.recall_id), T(minute(t.due_at)), T(t.status), T(minute(t.confirmed_at))]),
          },
        ],
      };
    }
  }
}

const cellText = (c: XCell): string =>
  c.v === null || c.v === ''
    ? ''
    : c.t === 'mass'
      ? Number(c.v).toFixed(3)
      : c.t === 'dec2'
        ? Number(c.v).toFixed(2)
        : String(c.v);

async function reportPdf(ctx: Ctx, r: Report): Promise<Uint8Array> {
  const doc = new PdfDocument(await loadFonts(ctx.cfg.loadAsset), { title: `AgroTrace — ${r.title}`, createdAt: ctx.store.nowIso() });
  const left = 28;
  const width = A4_LANDSCAPE.width - 2 * left;
  const bottom = A4_LANDSCAPE.height - 28;
  doc.addPage(A4_LANDSCAPE);
  let y = doc.paragraph(`AgroTrace — ${r.title}`, { x: left, y: 28, width }, 'bold', 14);
  y = doc.paragraph(r.periodLine, { x: left, y, width }, 'regular', 9);
  y = doc.paragraph(`Сформирован: ${minute(ctx.store.nowIso())} UTC`, { x: left, y, width }, 'regular', 9);
  for (const sheet of r.sheets) {
    y += 10;
    if (y > bottom - 40) {
      doc.addPage(A4_LANDSCAPE);
      y = 28;
    }
    y = doc.paragraph(sheet.name, { x: left, y, width }, 'bold', 11);
    const colW = width / sheet.header.length;
    const row = (cells: string[], weight: 'regular' | 'bold'): void => {
      const heights = cells.map((t, i) => doc.paragraph(t, { x: left + i * colW, y, width: colW - 4 }, weight, 7) - y);
      y += Math.max(9, ...heights) + 2;
      doc.line(left, y - 1, left + width, y - 1);
    };
    row(sheet.header, 'bold');
    for (const cells of sheet.rows) {
      if (y > bottom - 20) {
        doc.addPage(A4_LANDSCAPE);
        y = 28;
        row(sheet.header, 'bold');
      }
      row(cells.map(cellText), 'regular');
    }
  }
  return doc.toBytes();
}

export const analyticsHandlers: Record<string, Handler> = {
  getDashboard(ctx) {
    const p = ctx.user();
    const q = ctx.query();
    const scope = q.enumOf('scope', ['inspector', 'org', 'lab'] as const);
    if (!q.has('scope')) q.errors.scope = ['validation.required'];
    const allowed =
      (scope === 'inspector' && p.roles.some((r) => r === 'INSPECTOR' || r === 'ADMIN')) ||
      (scope === 'org' && p.roles.some((r) => r === 'FARMER' || r === 'PROCESSOR' || r === 'RETAILER')) ||
      (scope === 'lab' && p.roles.includes('LAB'));
    if (scope && !allowed) q.errors.scope = ['validation.scope.notAllowed'];
    const w = windowOf(ctx, q);
    return json(200, dashboard(ctx, p, scope!, w));
  },

  async downloadReport(ctx) {
    const p = ctx.user();
    const type = ctx.params.type ?? '';
    const access = ctx.op.reportAccess?.[type];
    if (!access) throw new ApiError(400, 'VALIDATION', { errors: { type: ['validation.enum'] } });
    const full = p.roles.some((r) => access.roles.includes(r));
    const head = !full && p.orgAdmin && p.roles.some((r) => access.headRoles.includes(r));
    if (!full && !head) throw new ApiError(403, 'FORBIDDEN');
    const q = ctx.query();
    const format = q.enumOf('format', ['xlsx', 'pdf'] as const);
    if (!q.has('format')) q.errors.format = ['validation.required'];
    let id = q.uuid('id');
    let w: { from: string; to: string } | null = null;
    if (type === 'recall') {
      q.notAllowed('from');
      q.notAllowed('to');
      if (!q.has('id')) q.errors.id = ['validation.required'];
      q.done();
    } else {
      if (type === 'org') {
        if (full && !q.has('id')) q.errors.id = ['validation.required'];
        if (head && id !== undefined && id !== p.orgId) q.errors.id = ['validation.id.notAllowed'];
        if (head) id = p.orgId;
      } else q.notAllowed('id');
      w = windowOf(ctx, q);
    }
    const report = buildReport(ctx, p, type, w, id ?? null, head);
    if (report.sheets.some((sh) => sh.rows.length > 50_000)) throw new ApiError(400, 'VALIDATION', { errors: { type: ['validation.report.tooManyRows'] } });
    const bytes = format === 'pdf' ? await reportPdf(ctx, report) : writeXlsx(report.sheets);
    const fileName = `${report.fileName}.${format}`;
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`,
        'Cache-Control': 'no-store',
      },
    });
  },
};

