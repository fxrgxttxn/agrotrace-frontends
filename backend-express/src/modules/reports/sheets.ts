/**
 * Report contents (downloadReport, contracts/openapi/paths/reports.yaml; FR-ANL-04, FR-ANL-05): the sheets of each
 * report type with the contract's names, columns, row orders and cell types, read in the caller's snapshot
 * (analytics/window.ts). Rendering (XLSX, PDF) is infra/xlsx.ts and infra/pdf.ts.
 *
 * Cells: text — a string; int — a count (format `0`); mass — kg as a number (format `0.000`); dec2 — percents and
 * `Hours` (format `0.00`); moments — text `YYYY-MM-DD HH:MM` in UTC, truncated to the minute (never rounded, R59);
 * booleans — `да`/`нет`; enum codes as in the API; null — an empty cell.
 *
 * Every data query reads at most `maxRows` + 1 rows (REPORT_MAX_ROWS, default 50 000): more than `maxRows` in any sheet is `errors.type:
 * [validation.report.tooManyRows]` (checked by the caller).
 */
import { sql, type Transaction } from 'kysely';
import machine from '../../../../contracts/rules/state-machine.json' with { type: 'json' };
import type { DB } from '../../db/types.generated.js';
import type { FileUrls } from '../../infra/file-urls.js';
import { hours } from '../analytics/dashboard.js';
import { bounds, type Window } from '../analytics/window.js';
import { loadRecall } from '../recalls/view.js';

type Tx = Transaction<DB>;

export const MAX_ROWS = 50_000;

export type Cell =
  | { t: 'text'; v: string | null }
  | { t: 'int'; v: number | null }
  | { t: 'mass'; v: string | null }
  | { t: 'dec2'; v: string | null };

export interface Sheet {
  name: string;
  header: string[];
  rows: Cell[][];
}

export interface Report {
  /** «Реестр партий» … (the PDF title is `AgroTrace — <title>`). */
  title: string;
  /** File name without the extension. */
  fileBase: string;
  /** `Период: <from> — <to> (UTC)` or `Отзыв: <id>`. */
  periodLine: string;
  sheets: Sheet[];
}

export const T = (v: string | null | undefined): Cell => ({ t: 'text', v: v ?? null });
export const N = (v: number | null | undefined): Cell => ({ t: 'int', v: v ?? null });
const M = (v: string | null): Cell => ({ t: 'mass', v });
const D2 = (v: string | null): Cell => ({ t: 'dec2', v });
const yes = (b: boolean): Cell => T(b ? 'да' : 'нет');

/** `YYYY-MM-DD HH:MM` (UTC), seconds and fractions truncated. */
export function minute(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = new Date(v as Date | string).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
}

const period = (w: Window) => `Период: ${w.from} — ${w.to} (UTC)`;
const LAB_OPEN = sql`('QUEUED', 'SAMPLED', 'ESCALATED')`;

// ── batches ─────────────────────────────────────────────────────────────────────────────────────────────────────

export async function batchesReport(
  tx: Tx,
  w: Window,
  headOrg: string | null,
  maxRows: number,
): Promise<Report> {
  const b = bounds(w);
  const rows = await sql<{
    public_code: string;
    product: string;
    category: string;
    kind: string;
    mass_kg: string;
    status: string;
    origin: string;
    holder: string | null;
    at: Date | null;
    test_required: boolean;
    test_reason: string;
    updated_at: Date;
  }>`
    SELECT b.public_code, p.name AS product, p.category, b.kind, b.mass_kg, b.status, o.name AS origin,
           h.name AS holder, coalesce(b.harvested_at, b.produced_at) AS at, b.test_required, b.test_reason,
           b.updated_at
      FROM batches b
      JOIN products p ON p.id = b.product_id
      JOIN organizations o ON o.id = b.origin_org_id
      LEFT JOIN organizations h ON h.id = b.holder_org_id
     WHERE b.deleted_at IS NULL
       AND coalesce(b.harvested_at, b.produced_at) >= ${b.start} AND coalesce(b.harvested_at, b.produced_at) < ${b.end}
       AND (${headOrg}::uuid IS NULL OR b.origin_org_id = ${headOrg}::uuid OR b.holder_org_id = ${headOrg}::uuid)
     ORDER BY b.public_code COLLATE "C"
     LIMIT ${maxRows + 1}`.execute(tx);
  return {
    title: 'Реестр партий',
    fileBase: `agrotrace-batches_${w.from}_${w.to}`,
    periodLine: period(w),
    sheets: [
      {
        name: 'Партии',
        header: [
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
        ],
        rows: rows.rows.map((r) => [
          T(r.public_code),
          T(r.product),
          T(r.category),
          T(r.kind),
          M(r.mass_kg),
          T(r.status),
          T(r.origin),
          T(r.holder),
          T(minute(r.at)),
          yes(r.test_required),
          T(r.test_reason),
          T(minute(r.updated_at)),
        ]),
      },
    ],
  };
}

// ── recalls (registry) ──────────────────────────────────────────────────────────────────────────────────────────

export async function recallsReport(tx: Tx, w: Window, maxRows: number): Promise<Report> {
  const b = bounds(w);
  const rows = await sql<{
    id: string;
    public_code: string;
    product: string;
    trigger: string;
    reason: string;
    status: string;
    opened_at: Date;
    closed_at: Date | null;
    secs: string | null;
    batches: number;
    total: number;
    confirmed: number;
    overdue: number;
  }>`
    SELECT r.id, b.public_code, p.name AS product, r.trigger, r.reason, r.status, r.opened_at, r.closed_at,
           floor(extract(epoch FROM r.closed_at - r.opened_at))::bigint::text AS secs,
           (SELECT count(*)::int FROM recall_batches rb WHERE rb.recall_id = r.id) AS batches,
           (SELECT count(*)::int FROM recall_tasks t WHERE t.recall_id = r.id) AS total,
           (SELECT count(*)::int FROM recall_tasks t WHERE t.recall_id = r.id AND t.status = 'CONFIRMED') AS confirmed,
           (SELECT count(*)::int FROM recall_tasks t
             WHERE t.recall_id = r.id AND t.status <> 'CONFIRMED' AND now() > t.due_at) AS overdue
      FROM recalls r
      JOIN batches b ON b.id = r.source_batch_id
      JOIN products p ON p.id = b.product_id
     WHERE r.deleted_at IS NULL AND r.opened_at >= ${b.start} AND r.opened_at < ${b.end}
     ORDER BY r.opened_at, r.id::text COLLATE "C"
     LIMIT ${maxRows + 1}`.execute(tx);
  return {
    title: 'Реестр отзывов',
    fileBase: `agrotrace-recalls_${w.from}_${w.to}`,
    periodLine: period(w),
    sheets: [
      {
        name: 'Отзывы',
        header: [
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
        ],
        rows: rows.rows.map((r) => [
          T(r.id),
          T(r.public_code),
          T(r.product),
          T(r.trigger),
          T(r.reason),
          T(r.status),
          T(minute(r.opened_at)),
          T(minute(r.closed_at)),
          D2(r.secs === null ? null : hours(r.secs, 1)),
          N(r.batches),
          N(r.total),
          N(r.confirmed),
          N(r.overdue),
        ]),
      },
    ],
  };
}

// ── recall (FR-ANL-04) ──────────────────────────────────────────────────────────────────────────────────────────

const EVENT_ORDER = ['RECALL_OPENED', 'TASK_CREATED', 'TASK_OVERDUE', 'TASK_CONFIRMED', 'RECALL_CLOSED'];
const codeCmp = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The recall report, or undefined when the recall does not exist or is deleted. */
export async function recallReport(tx: Tx, urls: FileUrls, id: string): Promise<Report | undefined> {
  const r = await loadRecall(tx, urls, id);
  if (!r) return undefined;
  const raw = await sql<{ opened_at: Date; closed_at: Date | null; origin: string }>`
    SELECT r.opened_at, r.closed_at, o.name AS origin
      FROM recalls r JOIN batches b ON b.id = r.source_batch_id JOIN organizations o ON o.id = b.origin_org_id
     WHERE r.id = ${id}`.execute(tx);
  const head = raw.rows[0]!;
  const taskRows = await sql<{
    id: string;
    escalated_at: Date | null;
    confirmed_at: Date | null;
    secs: string | null;
  }>`
    SELECT t.id, t.escalated_at, t.confirmed_at,
           floor(extract(epoch FROM t.confirmed_at - r.opened_at))::bigint::text AS secs
      FROM recall_tasks t JOIN recalls r ON r.id = t.recall_id
     WHERE t.recall_id = ${id}`.execute(tx);
  const byTask = new Map(taskRows.rows.map((t) => [t.id, t]));
  const source = r.sourceBatch.publicCode;
  const events: { at: number; order: number; event: string; code: string; org: string }[] = [];
  const add = (at: Date, event: string, code: string, org: string) =>
    events.push({ at: at.getTime(), order: EVENT_ORDER.indexOf(event), event, code, org });
  add(head.opened_at, 'RECALL_OPENED', source, head.origin);
  for (const t of r.tasks) {
    const raw = byTask.get(t.id)!;
    add(head.opened_at, 'TASK_CREATED', t.batch.publicCode, t.holder.name);
    if (raw.escalated_at) add(raw.escalated_at, 'TASK_OVERDUE', t.batch.publicCode, t.holder.name);
    if (raw.confirmed_at) add(raw.confirmed_at, 'TASK_CONFIRMED', t.batch.publicCode, t.holder.name);
  }
  if (head.closed_at) add(head.closed_at, 'RECALL_CLOSED', source, head.origin);
  events.sort((a, b) => a.at - b.at || a.order - b.order || codeCmp(a.code, b.code));
  return {
    title: 'Отчёт по отзыву',
    fileBase: `agrotrace-recall_${r.id}`,
    periodLine: `Отзыв: ${r.id}`,
    sheets: [
      {
        name: 'Отзыв',
        header: ['Поле', 'Значение'],
        rows: [
          [T('ID'), T(r.id)],
          [T('Исходная партия'), T(source)],
          [T('Продукт'), T(r.sourceBatch.product.name)],
          [T('Источник'), T(r.trigger)],
          [T('Причина'), T(r.reason)],
          [T('Статус'), T(r.status)],
          [T('Блокировка источников'), yes(r.blockUpstream)],
          [T('Открыт (UTC)'), T(minute(r.openedAt))],
          [T('Закрыт (UTC)'), T(minute(r.closedAt))],
          [T('Инициатор'), T(r.openedBy?.fullName ?? null)],
          [T('Партий'), N(r.batchesCount)],
          [T('Задач'), N(r.progress.total)],
          [T('Подтверждено'), N(r.progress.confirmed)],
        ],
      },
      {
        name: 'Партии',
        header: [
          'Код партии',
          'Продукт',
          'Направление',
          'Глубина',
          'Статус до отзыва',
          'Статус сейчас',
          'Держатель',
        ],
        rows: r.batches.map((m) => [
          T(m.batch.publicCode),
          T(m.batch.product.name),
          T(m.direction),
          N(m.depth),
          T(m.statusBefore),
          T(m.batch.status),
          T(m.batch.holder?.name ?? null),
        ]),
      },
      {
        name: 'Задачи',
        header: [
          'Код партии',
          'Держатель',
          'Срок (UTC)',
          'Статус',
          'Эскалирована (UTC)',
          'Подтверждена (UTC)',
          'Подтвердил',
          'Время подтверждения, ч',
        ],
        rows: r.tasks.map((t) => {
          const secs = byTask.get(t.id)!.secs;
          return [
            T(t.batch.publicCode),
            T(t.holder.name),
            T(minute(t.dueAt)),
            T(t.status),
            T(minute(t.escalatedAt)),
            T(minute(t.confirmedAt)),
            T(t.confirmedBy?.fullName ?? null),
            D2(secs === null ? null : hours(secs, 1)),
          ];
        }),
      },
      {
        name: 'Хронология',
        header: ['Время (UTC)', 'Событие', 'Партия', 'Организация'],
        rows: events.map((e) => [T(minute(new Date(e.at))), T(e.event), T(e.code), T(e.org)]),
      },
    ],
  };
}

// ── lab tests ───────────────────────────────────────────────────────────────────────────────────────────────────

export async function labTestsReport(
  tx: Tx,
  w: Window,
  headOrg: string | null,
  maxRows: number,
): Promise<Report> {
  const b = bounds(w);
  const rows = await sql<{
    public_code: string;
    product: string;
    lab: string;
    reason: string;
    status: string;
    conclusion: string | null;
    created_at: Date;
    due_at: Date;
    sampled_at: Date | null;
    completed_at: Date | null;
    overdue: boolean;
    exceeded: string | null;
  }>`
    SELECT b.public_code, p.name AS product, l.name AS lab, lt.reason, lt.status, lt.conclusion, lt.created_at,
           lt.due_at, lt.sampled_at, lt.completed_at,
           (lt.status IN ${LAB_OPEN} AND now() > lt.due_at) AS overdue,
           (SELECT string_agg(i.name, ', ' ORDER BY i.name COLLATE "C")
              FROM lab_results lr JOIN indicators i ON i.id = lr.indicator_id
             WHERE lr.lab_test_id = lt.id AND lr.is_exceeded) AS exceeded
      FROM lab_tests lt
      JOIN batches b ON b.id = lt.batch_id
      JOIN products p ON p.id = b.product_id
      JOIN organizations l ON l.id = lt.lab_org_id
     WHERE lt.deleted_at IS NULL AND b.deleted_at IS NULL
       AND lt.created_at >= ${b.start} AND lt.created_at < ${b.end}
       AND (${headOrg}::uuid IS NULL OR lt.lab_org_id = ${headOrg}::uuid)
     ORDER BY lt.created_at, lt.id::text COLLATE "C"
     LIMIT ${maxRows + 1}`.execute(tx);
  return {
    title: 'Лабораторные анализы',
    fileBase: `agrotrace-lab-tests_${w.from}_${w.to}`,
    periodLine: period(w),
    sheets: [
      {
        name: 'Анализы',
        header: [
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
        ],
        rows: rows.rows.map((r) => [
          T(r.public_code),
          T(r.product),
          T(r.lab),
          T(r.reason),
          T(r.status),
          T(r.conclusion),
          T(minute(r.created_at)),
          T(minute(r.due_at)),
          T(minute(r.sampled_at)),
          T(minute(r.completed_at)),
          yes(r.overdue),
          T(r.exceeded),
        ]),
      },
    ],
  };
}

// ── complaints ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function complaintsReport(tx: Tx, w: Window, maxRows: number): Promise<Report> {
  const b = bounds(w);
  const rows = await sql<{
    created_at: Date;
    public_code: string;
    product: string;
    text: string;
    status: string;
    decision: string | null;
    decision_comment: string | null;
    inspector: string | null;
    decided_at: Date | null;
  }>`
    SELECT c.created_at, b.public_code, p.name AS product, c.text, c.status, c.decision, c.decision_comment,
           u.full_name AS inspector, c.decided_at
      FROM complaints c
      JOIN batches b ON b.id = c.batch_id
      JOIN products p ON p.id = b.product_id
      LEFT JOIN users u ON u.id = c.inspector_id
     WHERE c.deleted_at IS NULL AND c.created_at >= ${b.start} AND c.created_at < ${b.end}
     ORDER BY c.created_at, c.id::text COLLATE "C"
     LIMIT ${maxRows + 1}`.execute(tx);
  return {
    title: 'Жалобы',
    fileBase: `agrotrace-complaints_${w.from}_${w.to}`,
    periodLine: period(w),
    sheets: [
      {
        name: 'Жалобы',
        header: [
          'Поступила (UTC)',
          'Код партии',
          'Продукт',
          'Текст',
          'Статус',
          'Решение',
          'Комментарий',
          'Инспектор',
          'Решение принято (UTC)',
        ],
        rows: rows.rows.map((r) => [
          T(minute(r.created_at)),
          T(r.public_code),
          T(r.product),
          T(r.text),
          T(r.status),
          T(r.decision),
          T(r.decision_comment),
          T(r.inspector),
          T(minute(r.decided_at)),
        ]),
      },
    ],
  };
}

// ── org ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The organization summary, or undefined when the organization does not exist or is deleted. */
export async function orgReport(
  tx: Tx,
  w: Window,
  orgId: string,
  maxRows: number,
): Promise<Report | undefined> {
  const o = await sql<{
    name: string;
    inn: string;
    type: string;
    region: string;
    status: string;
    trust_rating: number | null;
  }>`
    SELECT o.name, o.inn, o.type, r.name AS region, o.status, o.trust_rating
      FROM organizations o JOIN regions r ON r.id = o.region_id
     WHERE o.id = ${orgId} AND o.deleted_at IS NULL`.execute(tx);
  const org = o.rows[0];
  if (!org) return undefined;
  const b = bounds(w);
  const held = await sql<{ status: string; n: number }>`
    SELECT status, count(*)::int AS n FROM batches
     WHERE deleted_at IS NULL AND holder_org_id = ${orgId} GROUP BY status`.execute(tx);
  const counts = new Map(held.rows.map((r) => [r.status, r.n]));
  const isLab = org.type === 'LAB';
  const tests = await sql<{
    public_code: string;
    product: string;
    lab: string;
    conclusion: string | null;
    completed_at: Date;
  }>`
    SELECT b.public_code, p.name AS product, l.name AS lab, lt.conclusion, lt.completed_at
      FROM lab_tests lt
      JOIN batches b ON b.id = lt.batch_id
      JOIN products p ON p.id = b.product_id
      JOIN organizations l ON l.id = lt.lab_org_id
     WHERE lt.deleted_at IS NULL AND b.deleted_at IS NULL AND lt.status = 'DONE'
       AND lt.completed_at >= ${b.start} AND lt.completed_at < ${b.end}
       AND ${isLab ? sql`lt.lab_org_id = ${orgId}` : sql`b.origin_org_id = ${orgId}`}
     ORDER BY lt.completed_at, lt.id::text COLLATE "C"
     LIMIT ${maxRows + 1}`.execute(tx);
  const tasks = await sql<{
    public_code: string;
    recall_id: string;
    due_at: Date;
    status: string;
    confirmed_at: Date | null;
  }>`
    SELECT b.public_code, t.recall_id, t.due_at, t.status, t.confirmed_at
      FROM recall_tasks t
      JOIN recalls r ON r.id = t.recall_id
      JOIN batches b ON b.id = t.batch_id
     WHERE t.holder_org_id = ${orgId} AND r.deleted_at IS NULL AND b.deleted_at IS NULL
       AND t.created_at >= ${b.start} AND t.created_at < ${b.end}
     ORDER BY t.due_at, t.id::text COLLATE "C"
     LIMIT ${maxRows + 1}`.execute(tx);
  return {
    title: 'Сводка по организации',
    fileBase: `agrotrace-org_${org.inn}_${w.from}_${w.to}`,
    periodLine: period(w),
    sheets: [
      {
        name: 'Организация',
        header: ['Поле', 'Значение'],
        rows: [
          [T('Название'), T(org.name)],
          [T('ИНН'), T(org.inn)],
          [T('Тип'), T(org.type)],
          [T('Регион'), T(org.region)],
          [T('Статус'), T(org.status)],
          [T('Рейтинг доверия'), N(org.type === 'FARM' ? org.trust_rating : null)],
          [T('Период'), T(`${w.from} — ${w.to}`)],
        ],
      },
      {
        name: 'Партии по статусам',
        header: ['Статус', 'Количество'],
        rows: machine.statuses.map((s) => [T(s), N(counts.get(s) ?? 0)]),
      },
      {
        name: 'Анализы',
        header: ['Код партии', 'Продукт', 'Лаборатория', 'Заключение', 'Завершён (UTC)'],
        rows: tests.rows.map((r) => [
          T(r.public_code),
          T(r.product),
          T(r.lab),
          T(r.conclusion),
          T(minute(r.completed_at)),
        ]),
      },
      {
        name: 'Задачи отзыва',
        header: ['Код партии', 'ID отзыва', 'Срок (UTC)', 'Статус', 'Подтверждена (UTC)'],
        rows: tasks.rows.map((r) => [
          T(r.public_code),
          T(r.recall_id),
          T(minute(r.due_at)),
          T(r.status),
          T(minute(r.confirmed_at)),
        ]),
      },
    ],
  };
}
